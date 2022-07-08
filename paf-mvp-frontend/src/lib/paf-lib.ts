import { browserName } from 'detect-browser';
import {
  AuditLog,
  DeleteIdsPrefsResponse,
  Error,
  Get3PcResponse,
  GetIdsPrefsResponse,
  GetNewIdResponse,
  Identifier,
  IdsAndOptionalPreferences,
  IdsAndPreferences,
  PostIdsPrefsRequest,
  PostIdsPrefsResponse,
  PostSeedRequest,
  PostSignPreferencesRequest,
  Preferences,
  Seed,
  TransactionId,
  TransmissionResponse,
} from '@core/model';
import { Cookies, getPafRefreshExpiration, getPrebidDataCacheExpiration, typedCookie } from '@core/cookies';
import { jsonProxyEndpoints, proxyUriParams, redirectProxyEndpoints } from '@core/endpoints';
import { isBrowserKnownToSupport3PC } from '@core/user-agent';
import { QSParam } from '@core/query-string';
import { PafStatus } from '@frontend/enums/status.enum';
import { getCookieValue } from '../utils/cookie';
import { NotificationEnum } from '../enums/notification.enum';
import { Log } from '@core/log';
import { buildAuditLog } from '@core/model/audit-log';
import { mapAdUnitCodeToDivId } from '../utils/ad-unit-code';
import { executeInQueueAsync, setUpImmediateProcessingQueue, ImmediateProcessingQueue } from '../utils/queue';
import { Window } from '../global';
import { currentScript } from '@frontend/utils/current-script';

const log = new Log('OneKey', '#3bb8c3');

const redirect = (url: string): void => {
  log.Info('Redirecting to:', url);
  location.replace(url);
  log.Info('Stop queue');
  ((<Window>window).PAF.queue as ImmediateProcessingQueue).stopped = true;
};

// Note: we don't use Content-type JSON to avoid having to trigger OPTIONS pre-flight.
// See https://stackoverflow.com/questions/37668282/unable-to-fetch-post-without-no-cors-in-header
const postJson = (url: string, input: object) =>
  fetch(url, {
    method: 'POST',
    body: JSON.stringify(input),
    credentials: 'include',
  });

const postText = (url: string, input: string) =>
  fetch(url, {
    method: 'POST',
    body: input,
    credentials: 'include',
  });

const get = (url: string) =>
  fetch(url, {
    method: 'GET',
    credentials: 'include',
  });

const deleteHttp = (url: string) =>
  fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  });

// Remove any "paf data" param from the query string
// From https://stackoverflow.com/questions/1634748/how-can-i-delete-a-query-string-parameter-in-javascript/25214672#25214672
// TODO should be able to use a more standard way, but URL class is immutable :-(
const removeUrlParameters = (url: string, parameters: string[]) => {
  const urlParts = url.split('?');

  if (urlParts.length >= 2) {
    // Get first part, and remove from array
    const urlBase = urlParts.shift();

    // Join it back up
    const queryString = urlParts.join('?');

    const prefixes = parameters.map((param) => `${encodeURIComponent(param)}=`);
    const parts = queryString.split(/[&;]/g);

    // Reverse iteration as may be destructive
    prefixes.forEach((prefix) => {
      for (let i = parts.length; i-- > 0; ) {
        // Idiom for string.startsWith
        if (parts[i].lastIndexOf(prefix, 0) !== -1) {
          parts.splice(i, 1);
        }
      }
    });

    url = urlBase + (parts.length > 0 ? `?${parts.join('&')}` : '');
  }

  return url;
};

const setCookie = (cookieName: string, value: string, expiration: Date) => {
  document.cookie = `${cookieName}=${value};expires=${expiration.toUTCString()}`;
};

export const removeCookie = (cookieName: string) => {
  setCookie(cookieName, null, new Date(0));
};

const showNotificationIfValid = (consent: boolean | undefined) => {
  if (consent !== undefined) {
    notificationManager.fireEvent(consent ? NotificationEnum.personalizedContent : NotificationEnum.generalContent);
  }
};

const getProxyUrl =
  (clientHostname: string) =>
  (endpoint: string): string =>
    `https://${clientHostname}${endpoint}`;

export const saveCookieValue = <T>(cookieName: string, cookieValue: T | undefined): string => {
  const valueToStore = cookieValue === undefined ? PafStatus.NOT_PARTICIPATING : JSON.stringify(cookieValue);

  log.Debug(`Save cookie ${cookieName}:`, valueToStore);

  // TODO use different expiration if "not participating"
  setCookie(cookieName, valueToStore, getPrebidDataCacheExpiration());
  setCookie(Cookies.lastRefresh, new Date().toISOString(), getPafRefreshExpiration());

  return valueToStore;
};

let thirdPartyCookiesSupported: boolean | undefined;

export enum ShowPromptOption {
  doNotPrompt = 'doNotPrompt',
  doPrompt = 'doPrompt',
  promptIfUnknownUser = 'promptIfUnknownUser',
}

/**
 * Refresh result
 */
export interface RefreshResult {
  status: PafStatus;
  data?: IdsAndOptionalPreferences;
}

/**
 * Sign new optin value and send it with ids to the operator for writing
 * @param proxyHostName
 * @param optIn
 * @param identifiers
 */
export const updateIdsAndPreferences = async (
  optIn: boolean,
  identifiers: Identifier[]
): Promise<IdsAndOptionalPreferences | undefined> => {
  // 1. sign preferences
  const unsignedPreferences = {
    version: '0.1',
    data: {
      use_browsing_for_personalization: optIn,
    },
  };
  const signedPreferences = await signPreferences({
    identifiers,
    unsignedPreferences,
  });

  // 2. write
  return await writeIdsAndPref({
    identifiers,
    preferences: signedPreferences,
  });
};

/**
 *
 * @param idsAndPreferences
 * @param showPrompt
 */
async function updateDataWithPrompt(idsAndPreferences: RefreshResult, showPrompt: ShowPromptOption) {
  const { status, data } = idsAndPreferences;

  log.Debug('showPrompt', showPrompt);
  log.Debug('status', status);

  // If a redirect is needed, nothing more to do
  if (status === PafStatus.REDIRECT_NEEDED) {
    return;
  }

  let optIn: boolean | undefined;

  // Show prompt only if explicitly requested, or if user is unknown and prompt is accepted
  if (
    showPrompt === ShowPromptOption.doPrompt ||
    (showPrompt === ShowPromptOption.promptIfUnknownUser && status === PafStatus.UNKNOWN)
  ) {
    optIn = await promptManager.fireEvent();
  }

  if (optIn === undefined) {
    // User closed the prompt consent without defining their preferences, or the prompt was not even shown
    // => either they canceled modification of existing ids and preferences, or they don't want to participate

    // Was not participating => save this information
    if (status === PafStatus.UNKNOWN) {
      saveCookieValue(Cookies.identifiers, undefined);
      saveCookieValue(Cookies.preferences, undefined);
    }
    // Otherwise, don't do anything, preserve existing cookies
  } else {
    let identifiers = data.identifiers;
    if (identifiers?.length === 0) {
      // If opening the prompt while the user is unknown, it can happen that we need to query for a new id
      identifiers = [await getNewId()];
    }
    await updateIdsAndPreferences(optIn, identifiers);
  }
}

const getCleanCookieValue = (cookieValue: string): string | undefined =>
  cookieValue === PafStatus.NOT_PARTICIPATING || cookieValue === PafStatus.REDIRECT_NEEDED ? undefined : cookieValue;

/**
 * Parse string cookie values and build an IdsAndOptionalPreferences accordingly
 * @param idsCookie
 * @param prefsCookie
 */
const fromClientCookieValues = (idsCookie: string, prefsCookie: string): IdsAndOptionalPreferences => {
  return {
    identifiers: typedCookie(getCleanCookieValue(idsCookie)) ?? [],
    preferences: typedCookie(getCleanCookieValue(prefsCookie)),
  };
};

export const getPafStatus = (idsCookie: string, prefsCookie: string): PafStatus => {
  if (idsCookie === PafStatus.REDIRECT_NEEDED || prefsCookie === PafStatus.REDIRECT_NEEDED) {
    return PafStatus.REDIRECT_NEEDED;
  }

  // TODO might need to refine this one
  if (idsCookie === PafStatus.NOT_PARTICIPATING || prefsCookie === PafStatus.NOT_PARTICIPATING) {
    return PafStatus.NOT_PARTICIPATING;
  }

  return PafStatus.PARTICIPATING;
};

type CookieData = {
  strIds: string;
  lastRefresh: string;
  strPreferences: string;
  currentlySelectedConsent: boolean;
  currentPafData: IdsAndOptionalPreferences;
};

const getAllCookies = (): CookieData => {
  const strIds = getCookieValue(Cookies.identifiers);
  const strPreferences = getCookieValue(Cookies.preferences);
  const currentPafData = fromClientCookieValues(strIds, strPreferences);
  return {
    strIds,
    lastRefresh: getCookieValue(Cookies.lastRefresh),
    strPreferences,
    currentPafData,
    currentlySelectedConsent: currentPafData.preferences?.data?.use_browsing_for_personalization,
  };
};

const triggerNotification = (initialData: CookieData, newConsent: boolean) => {
  // the new value is different from the previous one
  if (newConsent !== initialData.currentlySelectedConsent) {
    log.Debug(
      `Preferences changes detected (${initialData.currentlySelectedConsent} => ${newConsent}), show notification`
    );
    showNotificationIfValid(newConsent);
  } else {
    log.Debug(`No preferences changes (${initialData.currentlySelectedConsent}), don't show notification`);
  }
};

const handleAfterBoomerangRedirect = async () => {
  // Update the URL shown in the address bar, without OneKey data
  const urlParams = new URLSearchParams(window.location.search);
  const uriOperatorData = urlParams.get(QSParam.paf);
  const uriShowPrompt = urlParams.get(localQSParamShowPrompt);

  const cleanedUrl = removeUrlParameters(location.href, [QSParam.paf, localQSParamShowPrompt]);
  history.pushState(null, '', cleanedUrl);

  // 1. Any OneKey 1st party cookie?
  const initialData = getAllCookies();

  log.Info(`Redirected from operator: ${uriOperatorData ? 'YES' : 'NO'}`);

  // 2. Redirected from operator?
  if (uriOperatorData) {
    // Consider that if we have been redirected, it means 3PC are not supported
    thirdPartyCookiesSupported = false;

    // Verify message
    const response = await postText(getUrl(jsonProxyEndpoints.verifyRead), uriOperatorData);
    const operatorData = (await response.json()) as GetIdsPrefsResponse | PostIdsPrefsResponse | DeleteIdsPrefsResponse;

    if (!operatorData) {
      throw 'Verification failed';
    }

    log.Debug('Operator data after redirect', operatorData);

    let status: PafStatus;

    // Remember what was asked for prompt, before the redirect
    const showPrompt = uriShowPrompt as ShowPromptOption;

    // 3. Received data?
    if (operatorData.body.preferences === undefined && operatorData.body.identifiers.length === 0) {
      // Deletion of ids and preferences requested
      saveCookieValue(Cookies.identifiers, undefined);
      saveCookieValue(Cookies.preferences, undefined);
      status = PafStatus.NOT_PARTICIPATING;

      log.Info('Deleted ids and preferences');
    } else {
      // Ids and preferences received
      const persistedIds = operatorData.body.identifiers?.filter((identifier) => identifier?.persisted !== false);
      const hasPersistedId = persistedIds.length > 0;
      const preferences = operatorData?.body?.preferences;
      const hasPreferences = preferences !== undefined;
      saveCookieValue(Cookies.identifiers, hasPersistedId ? persistedIds : undefined);
      saveCookieValue(Cookies.preferences, preferences);

      triggerNotification(initialData, preferences?.data?.use_browsing_for_personalization);

      status = hasPersistedId && hasPreferences ? PafStatus.PARTICIPATING : PafStatus.UNKNOWN;

      if (!hasPersistedId) {
        (<Window>window).PAF.unpersistedIds = operatorData.body.identifiers;
      }
    }

    // Now handle prompt, if relevant
    await updateDataWithPrompt(
      {
        status,
        data: operatorData.body,
      },
      showPrompt
    );
  }
};

// Special query string param to remember the prompt must be shown
const localQSParamShowPrompt = 'paf_show_prompt';

/**
 * Ensure local cookies for OneKey identifiers and preferences are up-to-date.
 * If they aren't, contact the operator to get fresh values.
 * @param options:
 * - proxyHostName: servername of the OneKey client node. ex: paf.my-website.com
 * - triggerRedirectIfNeeded: `true` if redirect can be triggered immediately, `false` if it should wait
 * - returnUrl: the URL that must be called in return (after a redirect to the operator) when no 3PC are available. Default = current page
 * @return a status and optional data
 */
export const refreshIdsAndPreferences = async (
  showPrompt: ShowPromptOption = ShowPromptOption.promptIfUnknownUser
): Promise<RefreshResult> => {
  log.Debug('refreshIdsAndPreferences', showPrompt);

  const redirectToRead = async () => {
    log.Info('Redirect to operator');

    const clientUrl = new URL(getUrl(redirectProxyEndpoints.read));
    const boomerangUrl = new URL(location.href);
    boomerangUrl.searchParams.set(localQSParamShowPrompt, showPrompt);

    clientUrl.searchParams.set(proxyUriParams.returnUrl, boomerangUrl.toString());
    const clientResponse = await get(clientUrl.toString());
    // TODO handle errors
    const operatorUrl = await clientResponse.text();
    redirect(operatorUrl);
  };

  const processRefreshIdsAndPreferences = async (): Promise<RefreshResult> => {
    // TODO the parsing and cleaning of the query string should be moved to a dedicated function
    const initialData = getAllCookies();

    const pafStatus = getPafStatus(initialData.strIds, initialData.strPreferences);

    if (pafStatus === PafStatus.REDIRECT_NEEDED) {
      log.Info('Redirect previously deferred');

      if (triggerRedirectIfNeeded) {
        await redirectToRead();
      }

      return {
        status: pafStatus,
      };
    }

    if (initialData.lastRefresh) {
      log.Info('Cookie found: YES');

      if (pafStatus === PafStatus.NOT_PARTICIPATING) {
        log.Info('User is not participating');
      }

      return {
        status: pafStatus,
        data: initialData.currentPafData,
      };
    }

    log.Info('Cookie found: NO');

    if (isBrowserKnownToSupport3PC(browserName(navigator.userAgent))) {
      log.Info('Browser known to support 3PC: YES');

      log.Info('Attempt to read from JSON');
      const readUrl = await get(getUrl(jsonProxyEndpoints.read));
      const readResponse = await get(await readUrl.text());
      const operatorData = (await readResponse.json()) as GetIdsPrefsResponse;

      const persistedIds = operatorData.body.identifiers?.filter((identifier) => identifier?.persisted !== false);
      const hasPersistedId = persistedIds.length > 0;
      const preferences = operatorData?.body?.preferences;
      const hasPreferences = preferences !== undefined;

      // 3. Received data?
      if (hasPersistedId && hasPreferences) {
        log.Debug('Operator returned id & prefs: YES');

        // If we got data, it means 3PC are supported
        thirdPartyCookiesSupported = true;

        // /!\ Note: we don't need to verify the message here as it is a REST call

        saveCookieValue(Cookies.identifiers, persistedIds);
        saveCookieValue(Cookies.preferences, operatorData.body.preferences);

        triggerNotification(initialData, operatorData.body.preferences?.data?.use_browsing_for_personalization);

        return {
          status: PafStatus.PARTICIPATING,
          data: operatorData.body,
        };
      }
      log.Info('Operator returned id & prefs: NO');

      log.Info('Verify 3PC on operator');
      // Note: need to include credentials to make sure cookies are sent
      const verifyUrl = await get(getUrl(jsonProxyEndpoints.verify3PC));
      const verifyResponse = await get(await verifyUrl.text());
      const testOk: Get3PcResponse | Error = await verifyResponse.json();

      // 4. 3d party cookie ok?
      if ((testOk as Get3PcResponse)?.['3pc']) {
        log.Debug('3PC verification OK: YES');

        thirdPartyCookiesSupported = true;

        // Save the newly generated id(s)
        (<Window>window).PAF.unpersistedIds = operatorData.body.identifiers;

        return {
          status: PafStatus.UNKNOWN,
          data: {
            identifiers: operatorData.body.identifiers,
          },
        };
      }
      log.Info('3PC verification OK: NO');
      thirdPartyCookiesSupported = false;
      log.Info('Fallback to JS redirect');
    } else {
      log.Info('Browser known to support 3PC: NO');
      thirdPartyCookiesSupported = false;
      log.Info('JS redirect');
    }

    if (triggerRedirectIfNeeded) {
      await redirectToRead();
    } else {
      log.Info('Deffer redirect to later, in agreement with options');
      saveCookieValue(Cookies.identifiers, PafStatus.REDIRECT_NEEDED);
      saveCookieValue(Cookies.preferences, PafStatus.REDIRECT_NEEDED);
    }

    return {
      status: PafStatus.REDIRECT_NEEDED,
    };
  };

  const idsAndPreferences = await processRefreshIdsAndPreferences();

  log.Debug('refreshIdsAndPreferences return', idsAndPreferences);

  // Now handle prompt, if relevant
  await updateDataWithPrompt(idsAndPreferences, showPrompt);

  (<Window>window).PAF.status = idsAndPreferences.status;

  return idsAndPreferences;
};

/**
 * Write update of identifiers and preferences on the OneKey domain
 * @param options:
 * - proxyBase: base URL (scheme, servername) of the OneKey client node. ex: https://paf.my-website.com
 * @param input the identifiers and preferences to write
 * @return the written identifiers and preferences
 */
const writeIdsAndPref = async (input: IdsAndPreferences): Promise<IdsAndOptionalPreferences | undefined> => {
  const getUrl = getProxyUrl(clientHostname);

  const processWriteIdsAndPref = async (): Promise<IdsAndOptionalPreferences | undefined> => {
    log.Info('Attempt to write:', input.identifiers, input.preferences);

    // First clean up local cookies
    removeCookie(Cookies.identifiers);
    removeCookie(Cookies.preferences);

    // FIXME this boolean will be up to date only if a read occurred just before. If not, would need to explicitly test
    if (thirdPartyCookiesSupported) {
      log.Info('3PC supported');

      // 1) sign the request
      const signedResponse = await postJson(getUrl(jsonProxyEndpoints.signWrite), input);
      const signedData = (await signedResponse.json()) as PostIdsPrefsRequest;

      // 2) send
      // TODO in fact, this post endpoint should take the unsigned input, sign it and return both the signed input and the url to call
      const clientResponse = await postText(getUrl(jsonProxyEndpoints.write), '');
      // TODO handle errors
      const operatorUrl = await clientResponse.text();
      const operatorResponse = await postJson(operatorUrl, signedData);
      const operatorData = (await operatorResponse.json()) as GetIdsPrefsResponse;

      const persistedIds = operatorData?.body?.identifiers?.filter((identifier) => identifier?.persisted !== false);
      const hasPersistedId = persistedIds.length > 0;

      saveCookieValue(Cookies.identifiers, hasPersistedId ? persistedIds : undefined);
      saveCookieValue(Cookies.preferences, operatorData.body.preferences);

      showNotificationIfValid(operatorData?.body?.preferences?.data?.use_browsing_for_personalization);

      return operatorData.body;
    }

    log.Info('3PC not supported: redirect');

    // Redirect. Signing of the request will happen on the backend proxy
    const clientUrl = new URL(getUrl(redirectProxyEndpoints.write));
    clientUrl.searchParams.set(proxyUriParams.returnUrl, location.href);
    clientUrl.searchParams.set(proxyUriParams.message, JSON.stringify(input));

    const clientResponse = await get(clientUrl.toString());
    // TODO handle errors
    const operatorUrl = await clientResponse.text();
    redirect(operatorUrl);
  };

  const idsAndPreferences = await processWriteIdsAndPref();

  log.Info('Finished', idsAndPreferences);

  return idsAndPreferences;
};

/**
 * Sign preferences
 * @param options:
 * - proxyBase: base URL (scheme, servername) of the OneKey client node. ex: https://paf.my-website.com
 * @param input the main identifier of the web user, and the optin value
 * @return the signed Preferences
 */
export const signPreferences = async (input: PostSignPreferencesRequest): Promise<Preferences> => {
  const getUrl = getProxyUrl(clientHostname);

  // TODO use ProxyRestSignPreferencesRequestBuilder
  const signedResponse = await postJson(getUrl(jsonProxyEndpoints.signPrefs), input);
  return (await signedResponse.json()) as Preferences;
};

/**
 * Get new random identifier
 * @param options:
 * - proxyBase: base URL (scheme, servername) of the OneKey client node. ex: https://paf.my-website.com
 * @return the new Id, signed
 */
export const getNewId = async (): Promise<Identifier> => {
  const getUrl = getProxyUrl(clientHostname);

  const newIdUrl = await get(getUrl(jsonProxyEndpoints.newId));
  const response = await get(await newIdUrl.text());
  // Assume no error. FIXME should handle potential errors
  return ((await response.json()) as GetNewIdResponse).body.identifiers[0];
};

/**
 * Get Ids and Preferences by checking locally and refresh it if necessary.
 */
export const getIdsAndPreferences: () => Promise<IdsAndPreferences | undefined> = executeInQueueAsync<
  void,
  IdsAndPreferences | undefined
>(async () => {
  let data = getIdsAndPreferencesFromCookies();

  // If data is not available locally, refresh from the operator
  if (data === undefined) {
    const refreshed = await refreshIdsAndPreferences();
    if (refreshed.status === PafStatus.PARTICIPATING) {
      data = refreshed.data as IdsAndPreferences;
    }
  }

  return data;
});

/**
 * If at least one identifier and some preferences are present as a 1P cookie, return them
 * Otherwise, return undefined
 */
export const getIdsAndPreferencesFromCookies: () => IdsAndPreferences | undefined = () => {
  if (!getCookieValue(Cookies.lastRefresh)) {
    return undefined;
  }
  
  // Remove special string values
  const cleanCookieValue = (rawValue: string) =>
    rawValue === PafStatus.REDIRECT_NEEDED || rawValue === PafStatus.NOT_PARTICIPATING ? undefined : rawValue;

  const strIds = cleanCookieValue(getCookieValue(Cookies.identifiers));
  const strPreferences = cleanCookieValue(getCookieValue(Cookies.preferences));

  const values = fromClientCookieValues(strIds, strPreferences);

  // If the object is not complete (no identifier or no preferences), then consider no valid data
  if (values.identifiers === undefined || values.identifiers.length === 0 || values.preferences === undefined) {
    return undefined;
  }

  return values as IdsAndPreferences;
};

/**
 * Aggregate Seed and Preferences for storage.
 *
 * We must record the Ids and Preferences
 * in case they change in the cookies after the
 * generation of the Seed.
 */
export interface SeedEntry {
  seed: Seed;
  idsAndPreferences: IdsAndPreferences;
}

type PrebidTransactionId = string;
type DivId = string;
type ContentId = string;

export interface AuditHandler {
  // Binds the element to the audit handler.
  bind(element: HTMLElement): void;
}

export interface TransmissionRegistryContext {
  /** Transaction Id generated by Prebidjs. */
  prebidTransactionId: PrebidTransactionId;
  /** Transaction Id generated for the OneKey Audit Log and used for signing the Seed. */
  pafTransactionId: TransactionId;
  /**
   * The Id of the tag (<div id="something">) that contains the
   * addressable content or the Google Publisher Tag adUnitCode.
   */
  divIdOrAdUnitCode: string;
  contentId: ContentId;
  auditHandler?: AuditHandler;
}

/** Internal storage for generated Seeds. */
const seedStorage = new Map<TransactionId, SeedEntry>();
/** Internal storage for fetching the Audit Log for a given Prebid Transaction Id. */
const auditLogByPrebidTransactionId = new Map<PrebidTransactionId, AuditLog>();
/**
 * Internal storage for fetching the Prebid Transaction Id for a Div id.
 * Usefull for fetching the Audit Log then.
 */
const prebidTransactionIdByDivId = new Map<DivId, PrebidTransactionId>();

export const createSeed = async (transactionIds: TransactionId[]): Promise<SeedEntry | undefined> => {
  if (transactionIds.length == 0) {
    return undefined;
  }
  const getUrl = getProxyUrl(clientHostname);
  const url = getUrl(jsonProxyEndpoints.createSeed);
  const idsAndPreferences = await getIdsAndPreferences();
  if (idsAndPreferences === undefined) {
    return undefined;
  }

  const requestContent: PostSeedRequest = {
    transaction_ids: transactionIds,
    data: idsAndPreferences,
  };
  const response = await postJson(url, requestContent);
  const seed = (await response.json()) as Seed;

  return {
    seed,
    idsAndPreferences,
  };
};

/**
 * Call hostname endpoint for generating a seed
 * and store the Seed on Browser side so that it can be retrieved later.
 *
 * @param options domain called for creating the Seed (POST /paf-proxy/v1/seed).
 * @param pafTransactionIds List of Transaction Ids for OneKey (visible in the Audit).
 * @returns A new signed Seed that can be used to start Transmissions Requests.
 */
export const generateSeed = async (pafTransactionIds: TransactionId[]): Promise<Seed | undefined> => {
  const entry = await createSeed(pafTransactionIds);

  if (entry !== undefined) {
    for (const id of pafTransactionIds) {
      seedStorage.set(id, entry);
    }
  }

  return entry?.seed;
};

/**
 * Register the Transmission Response of an initial Transmission Request for a given Seed.
 * @param context
 * @param transmissionResponse Transmission Response of an initial Transmission Request containing all the children.
 * @returns The generated AuditLog or undefined if the given Transaction Id is unknown or malformed.
 */
export const registerTransmissionResponse = (
  { prebidTransactionId, pafTransactionId, divIdOrAdUnitCode, contentId, auditHandler }: TransmissionRegistryContext,
  transmissionResponse: TransmissionResponse
): AuditLog | undefined => {
  const divId = mapAdUnitCodeToDivId(divIdOrAdUnitCode) || divIdOrAdUnitCode;
  const divContainer = document.getElementById(divId);
  if (divContainer === undefined) {
    return undefined;
  }

  const seedEntry = seedStorage.get(pafTransactionId);
  if (seedEntry === undefined) {
    return undefined;
  }

  const auditLog = buildAuditLog(seedEntry.seed, seedEntry.idsAndPreferences, transmissionResponse, contentId);
  if (auditLog === undefined) {
    return undefined;
  }

  auditLogByPrebidTransactionId.set(prebidTransactionId, auditLog);
  prebidTransactionIdByDivId.set(divId, prebidTransactionId);

  if (auditHandler) {
    auditHandler.bind(divContainer);
  }

  return auditLog;
};

/**
 * @param prebidTransactionId Transaction Id generated by Prebidjs.
 * @returns The Audit Log attached to the Prebid Transaction Id.
 */
export const getAuditLogByTransaction = (prebidTransactionId: PrebidTransactionId): AuditLog | undefined => {
  return auditLogByPrebidTransactionId.get(prebidTransactionId);
};

/**
 * @param divId The id of the tag (<div id="something">) that contains the addressable content..
 * @returns The Audit Log attached to this DivId.
 */
export const getAuditLogByDivId = (divId: DivId): AuditLog | undefined => {
  const prebidTransactionId = prebidTransactionIdByDivId.get(divId);
  if (prebidTransactionId === undefined) {
    return undefined;
  }
  return getAuditLogByTransaction(prebidTransactionId);
};

/**
 * Delete the identifiers and preferences of the current website (locally and from the operator)
 * @param options:
 * - proxyBase: base URL (scheme, servername) of the PAF client node. ex: https://paf.my-website.com
 */
export const deleteIdsAndPreferences = async (): Promise<void> => {
  log.Info('Attempt to delete ids and preferences');

  const strIds = getCookieValue(Cookies.identifiers);
  const strPreferences = getCookieValue(Cookies.preferences);
  const pafStatus = getPafStatus(strIds, strPreferences);

  if (pafStatus === PafStatus.NOT_PARTICIPATING) {
    log.Info('User is already not participating, nothing to clean');
    return;
  }

  const getUrl = getProxyUrl(clientHostname);

  // FIXME this boolean will be up to date only if a read occurred just before. If not, would need to explicitly test
  if (thirdPartyCookiesSupported) {
    log.Info('3PC supported: deleting the ids and preferences');

    // Get the signed request for the operator
    const clientNodeDeleteResponse = await deleteHttp(getUrl(jsonProxyEndpoints.delete));
    const operatorDeleteUrl = await clientNodeDeleteResponse.text();

    // Call the operator, which will clean its cookies
    await deleteHttp(operatorDeleteUrl);

    // Clean the local cookies
    saveCookieValue(Cookies.identifiers, undefined);
    saveCookieValue(Cookies.preferences, undefined);

    log.Info('Deleted ids and preferences');
    return;
  }

  log.Info('3PC not supported: redirecting to delete ids and preferences');

  // Redirect. Signing of the request will happen on the backend proxy
  const clientUrl = new URL(getUrl(redirectProxyEndpoints.delete));
  clientUrl.searchParams.set(proxyUriParams.returnUrl, location.href);
  const clientResponse = await get(clientUrl.toString());

  // TODO handle errors
  const operatorUrl = await clientResponse.text();
  redirect(operatorUrl);
};

// Get proxy-hostname
currentScript.setScript(document.currentScript as HTMLScriptElement);
const clientHostname = currentScript.getData()?.clientHostname;

const getUrl = getProxyUrl(clientHostname);

const triggerRedirectIfNeeded =
  currentScript.getData()?.upFrontRedirect !== undefined ? currentScript.getData().upFrontRedirect : true;

class EventHandler<IN, OUT> {
  private _handler?: (arg: IN) => Promise<OUT>;
  private _handlerResolver: { resolve: (value: OUT | PromiseLike<OUT>) => void; reject: (reason?: any) => void };
  private _arg: IN;

  fireEvent(arg: IN): Promise<OUT> {
    if (this._handler) {
      // The handler already exists, let's trigger it
      return this._handler(arg);
    }
    // If the handler has not been set yet, create a promise that will resolve when it is set
    return new Promise<OUT>((resolve, reject) => {
      // TODO might need to deal with the situation where the handlerResolver is already set
      this._handlerResolver = {
        resolve,
        reject,
      };
      this._arg = arg;
    });
  }

  set handler(handler: (arg: IN) => Promise<OUT>) {
    if (this._handlerResolver) {
      // An event was already waiting for this, resolve the promise
      handler(this._arg).then(this._handlerResolver.resolve, this._handlerResolver.reject);
    }
    this._handler = handler;
  }
}

const promptManager = new EventHandler<void, boolean>();

export const setPromptHandler = (handler: () => Promise<boolean>) => {
  promptManager.handler = handler;
};

const notificationManager = new EventHandler<NotificationEnum, void>();

export const setNotificationHandler = (handler: (notificationType: NotificationEnum) => Promise<void>) => {
  notificationManager.handler = handler;
};

(async () =>
  await setUpImmediateProcessingQueue((<Window>window).PAF, async () => {
    await handleAfterBoomerangRedirect();
    return true;
  }))();
