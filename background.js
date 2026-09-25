const ALARM = "reborn-vote";
const AJAX = "https://l2reborn.org/wp-admin/admin-ajax.php";
const COOLDOWN_MS = 12 * 60 * 60 * 1000;

const SERVERS = [
  { id: "2", name: "Eternal Main", rate: "x10", label: "Main" },
  { id: "9", name: "Eternal Season", rate: "x10~x30", label: "New" },
  { id: "6", name: "Essence Guardian", rate: "x1", label: "New" },
  { id: "3", name: "Essence Aden", rate: "x3~x1", label: "Main" },
  { id: "10", name: "Essence Goddard", rate: "x3~x1", label: "New" },
  { id: "5", name: "Signature Teon", rate: "x1", label: "Main" },
  { id: "1", name: "Origins", rate: "x3~x1", label: "Main" },
  { id: "4", name: "Forever", rate: "x15", label: "Main" }
];

const ERRORS = {
  2: "Голос не подтвердился.",
  3: "Награда уже получена. Следующая попытка через 12 часов.",
  4: "Голос не подтвердился."
};

chrome.runtime.onInstalled.addListener(() => reschedule());
chrome.runtime.onStartup.addListener(() => reschedule());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) startRun("alarm");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RESCHEDULE") {
    reschedule().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "RUN_NOW") {
    startRun("manual").then((result) => sendResponse(result));
    return true;
  }
  if (msg.type === "REFRESH_CATALOG") {
    loadCatalog().then(async (result) => {
      if (!result.ok && result.auth) await promptLogin(result.message);
      sendResponse(result);
    });
    return true;
  }
  if (msg.type === "CLEAR_HISTORY") {
    chrome.storage.local.set({ history: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function reschedule() {
  const { settings, nextEligibleAt } = await chrome.storage.local.get(["settings", "nextEligibleAt"]);
  await chrome.alarms.clear(ALARM);
  if (!settings?.enabled) return;
  const minutes = clampInterval(settings.intervalMinutes);
  let delay = minutes;
  if (nextEligibleAt) {
    const untilEligible = Math.ceil((nextEligibleAt - Date.now()) / 60000);
    if (untilEligible > 0) delay = Math.max(minutes, untilEligible);
  }
  chrome.alarms.create(ALARM, { periodInMinutes: minutes, delayInMinutes: delay });
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 720;
  return Math.min(1440, Math.max(30, Math.round(n)));
}

async function startRun(source) {
  const { settings, activeRun, nextEligibleAt } = await chrome.storage.local.get([
    "settings",
    "activeRun",
    "nextEligibleAt"
  ]);
  if (source === "alarm" && !settings?.enabled) return { ok: false, message: "Выключено" };
  if (activeRun && Date.now() - activeRun.startedAt < 20000) {
    return { ok: false, message: "Запрос уже выполняется" };
  }
  if (source === "alarm" && nextEligibleAt && Date.now() < nextEligibleAt) {
    await setStatus({
      state: "waiting",
      message: "Награда уже получена. Следующая проверка " + formatTime(nextEligibleAt)
    });
    return { ok: false, message: "Кулдаун" };
  }
  if (!settings?.serverId || !settings.account || !settings.characterName) {
    await setStatus({ state: "error", message: "Выберите сервер, аккаунт и персонажа" });
    return { ok: false, message: "Нет настроек" };
  }

  await chrome.storage.local.set({
    activeRun: { id: String(Date.now()), source, startedAt: Date.now(), phase: "Отправляю запросы" }
  });
  await setStatus({ state: "running", message: "Получаю награду" });

  try {
    const result = await claimReward(settings, source);
    await finishRun(result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      auth: !!error.auth,
      message: error.message || "Не удалось получить награду"
    };
    if (error.auth) await promptLogin(error.message);
    if (error.cloudflare) await showSiteTab();
    await finishRun(result);
    return result;
  }
}

async function claimReward(settings, source) {
  const meta = {
    source,
    server: settings.serverLabel || settings.serverId,
    account: settings.account,
    character: settings.characterName
  };
  const catalog = await loadCatalog();
  if (!catalog.ok) throw catalogError(catalog);

  const characterId = resolveCharacterId(catalog.catalog, settings);
  if (!characterId) throw new Error("Персонаж не найден на этом аккаунте");

  const nonceResp = await ajaxPost({ action: "l2mgm_nonce", nonce_name: "shop" });
  const nonce = nonceResp?.data?.nonce;
  await pushHistory({ ...meta, step: "Сессия", ok: !!nonce, message: nonce ? "Сессия активна" : "Нужно войти заново" });
  if (!nonce) throw authError("Сессия закончилась. Войдите в личный кабинет.");

  const tokenResp = await ajaxGet({ action: "l2mgm_get_vip_token", server_id: settings.serverId });
  const token = tokenResp?.data?.token;
  await pushHistory({
    ...meta,
    step: "Токен голосования",
    ok: !!token,
    message: token ? "Токен получен" : (tokenResp?.data?.message || "Токен не выдан")
  });
  if (!token) throw new Error(tokenResp?.data?.message || "Не удалось получить токен голосования");

  const validate = await siteRequest(
    "https://l2reborn.org/fast_vote.php?action=l2mgm_validate_vip_token&token=" + encodeURIComponent(token)
  );
  await pushHistory({
    ...meta,
    step: "Подтверждение голоса",
    ok: validate.ok && !isChallenge(validate),
    message: "HTTP " + validate.status
  });
  if (isChallenge(validate)) throw cloudflareError(validate.status);

  const claim = await ajaxPost({
    action: "l2mgm_donation_service_v2",
    service: "exp_rune",
    server_id: String(settings.serverId),
    account: settings.account,
    character: String(characterId),
    vote_token: token,
    vote_retries: "0",
    _wpnonce: nonce
  });

  if (claim?.success) {
    await pushHistory({ ...meta, step: "Награда", ok: true, message: "Руна отправлена персонажу " + settings.characterName });
    return { ok: true, message: "Награда отправлена персонажу " + settings.characterName };
  }

  const code = claim?.data?.error_code;
  const message = ERRORS[code] || claim?.data?.message || "Магазин не принял запрос";
  await pushHistory({ ...meta, step: "Награда", ok: false, message });
  if (code === 3) return { ok: false, skipped: true, message };
  throw new Error(message);
}

function authError(message) {
  const error = new Error(message);
  error.auth = true;
  return error;
}

function catalogError(catalog) {
  const error = catalog.auth ? authError(catalog.message) : new Error(catalog.message);
  if (catalog.cloudflare) error.cloudflare = true;
  return error;
}

function cloudflareError(status) {
  const error = new Error(
    "Cloudflare отклонил запрос (HTTP " + status + "). Откройте l2reborn.org, обновите страницу и повторите."
  );
  error.cloudflare = true;
  return error;
}

async function promptLogin(message) {
  await setStatus({ state: "auth", message: message || "Нужно войти в личный кабинет" });
  const loginUrl = chrome.runtime.getURL("login/login.html");
  const tabs = await chrome.tabs.query({ url: loginUrl });
  if (tabs[0]) {
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    await chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url: loginUrl, type: "popup", width: 440, height: 320, focused: true });
}

async function pushHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    ...entry
  });
  await chrome.storage.local.set({ history: history.slice(0, 200) });
}

function resolveCharacterId(catalog, settings) {
  if (settings.characterId) return settings.characterId;
  const accounts = catalog?.byServer?.[String(settings.serverId)] || [];
  const account = accounts.find((item) => item.name === settings.account);
  const character = account?.characters?.find((item) => item.name === settings.characterName);
  return character?.id || "";
}

async function loadCatalog() {
  let payload;
  try {
    payload = await ajaxGet({ action: "l2mgm_account", section: "shop" });
  } catch (error) {
    return {
      ok: false,
      cloudflare: !!error.cloudflare,
      message: error.message || "Нет связи с l2reborn.org"
    };
  }
  if (!payload?.success) {
    await pushHistory({ source: "catalog", step: "Аккаунты", ok: false, message: "Нужно войти заново" });
    return { ok: false, auth: true, message: "Сессия закончилась. Войдите в личный кабинет." };
  }

  const characters = payload.data.characters || [];
  const accounts = payload.data.accounts || [];
  const byServer = {};
  const source = accounts.length ? accounts : characters.map((character) => ({
    server_id: character.server_id,
    account_name: character.account_name
  }));

  source.forEach((account) => {
    const serverId = String(account.server_id);
    if (!byServer[serverId]) byServer[serverId] = [];
    if (byServer[serverId].some((item) => item.name === account.account_name)) return;
    byServer[serverId].push({
      name: account.account_name,
      characters: characters
        .filter((character) => String(character.server_id) === serverId && character.account_name === account.account_name)
        .map((character) => ({ id: String(character.obj_id), name: character.char_name }))
    });
  });

  const catalog = { servers: SERVERS, byServer, loggedIn: true };
  await chrome.storage.local.set({ catalog, catalogAt: Date.now() });
  return { ok: true, catalog };
}

async function ajaxGet(params) {
  const url = new URL(AJAX);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return readJson(await siteRequest(url.toString()));
}

async function ajaxPost(params) {
  return readJson(await siteRequest(AJAX, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams(params).toString()
  }));
}

function readJson(result) {
  if (isChallenge(result)) throw cloudflareError(result.status);
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error("Сайт вернул не JSON (HTTP " + result.status + ")");
  }
}

function isChallenge(result) {
  if (!result) return false;
  const text = (result.text || "").trim();
  if (text.startsWith("{") || text.startsWith("[")) return false;
  return result.status === 403 || (result.status >= 400 && text.startsWith("<"));
}

async function siteRequest(url, options = {}) {
  const tab = await ensureSiteTab();
  let injected;
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: pageFetch,
      args: [url, {
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body || ""
      }]
    });
  } catch {
    throw new Error("Не удалось выполнить запрос со страницы l2reborn.org. Откройте сайт и обновите вкладку.");
  }
  const result = injected?.[0]?.result;
  if (!result) throw new Error("Страница l2reborn.org не ответила");
  if (result.error) throw new Error("Запрос со страницы не выполнился: " + result.error);
  return result;
}

function pageFetch(requestUrl, requestInit) {
  const init = {
    method: requestInit.method || "GET",
    credentials: "include",
    headers: requestInit.headers || {}
  };
  if (requestInit.body) init.body = requestInit.body;
  return fetch(requestUrl, init).then(async (response) => {
    const text = await response.text();
    const trimmed = text.trim();
    const jsonLike = trimmed.startsWith("{") || trimmed.startsWith("[");
    return {
      ok: response.ok,
      status: response.status,
      text: jsonLike ? text : trimmed.slice(0, 240)
    };
  }).catch((error) => ({
    ok: false,
    status: 0,
    text: "",
    error: error && error.message ? error.message : String(error)
  }));
}

async function ensureSiteTab() {
  const tabs = await chrome.tabs.query({ url: "https://l2reborn.org/*" });
  if (!tabs.length) {
    const created = await chrome.tabs.create({ url: "https://l2reborn.org/shop/", active: false });
    await waitForTab(created.id);
    return chrome.tabs.get(created.id);
  }
  const tab = tabs.find((item) => item.status === "complete" && !item.discarded) || tabs[0];
  if (tab.discarded || tab.status !== "complete") await reloadAndWait(tab.id);
  return chrome.tabs.get(tab.id);
}

async function showSiteTab() {
  const tabs = await chrome.tabs.query({ url: "https://l2reborn.org/*" });
  const tab = tabs[0] || await chrome.tabs.create({ url: "https://l2reborn.org/shop/", active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Страница l2reborn.org не загрузилась"));
    }, 20000);
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete" && !tab.discarded) finish();
    }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

function reloadAndWait(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Страница l2reborn.org не загрузилась"));
    }, 20000);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

async function finishRun(msg) {
  const lastResult = {
    ok: !!msg.ok,
    skipped: !!msg.skipped,
    message: msg.message || "",
    at: Date.now()
  };
  const patch = { activeRun: null, lastResult };
  if (msg.ok || msg.skipped) patch.nextEligibleAt = Date.now() + COOLDOWN_MS;
  await chrome.storage.local.set(patch);
  await reschedule();
  await setStatus({
    state: msg.auth ? "auth" : msg.ok ? "ok" : msg.skipped ? "waiting" : "error",
    message: msg.message || (msg.ok ? "Награда получена" : "Ошибка")
  });
  chrome.notifications.create("reborn-vote-" + Date.now(), {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: msg.ok ? "Награда получена" : msg.skipped ? "Уже получено" : "Reborn Vote",
    message: msg.message || ""
  }).catch(() => {});
}

async function setStatus(status) {
  await chrome.storage.local.set({ status: { ...status, at: Date.now() } });
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}
