const serverEl = document.getElementById("server");
const accountEl = document.getElementById("account");
const characterEl = document.getElementById("character");
const intervalEl = document.getElementById("interval");
const customWrap = document.getElementById("custom-wrap");
const customMinutes = document.getElementById("custom-minutes");
const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");

let catalog = { servers: [], byServer: {} };
let settings = {};

if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
  document.getElementById("version").textContent = chrome.runtime.getManifest().version;
}

init();

async function init() {
  const stored = await chrome.storage.local.get(["settings", "catalog", "status", "lastResult", "nextEligibleAt"]);
  settings = stored.settings || {};
  catalog = stored.catalog || catalog;
  enabledEl.checked = !!settings.enabled;
  fillServers();
  applyInterval(settings.intervalMinutes || 720);
  renderStatus(stored);
  bind();
}

function bind() {
  serverEl.addEventListener("change", () => {
    fillAccounts();
    save();
  });
  accountEl.addEventListener("change", () => {
    fillCharacters();
    save();
  });
  characterEl.addEventListener("change", save);
  intervalEl.addEventListener("change", () => {
    customWrap.hidden = intervalEl.value !== "custom";
    save();
  });
  customMinutes.addEventListener("change", save);
  enabledEl.addEventListener("change", save);
  document.getElementById("run").addEventListener("click", async () => {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "RUN_NOW" });
    if (response && response.message && !response.ok) setStatusText(response.message, "error");
  });
  document.getElementById("login").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://l2reborn.org/shop/#essence" });
  });
  document.getElementById("history").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
  });
  document.getElementById("refresh").addEventListener("click", async () => {
    const button = document.getElementById("refresh");
    button.disabled = true;
    setStatusText("Загружаю аккаунты из кабинета…", "waiting");
    try {
      const response = await chrome.runtime.sendMessage({ type: "REFRESH_CATALOG" });
      if (!response) {
        setStatusText("Расширение не ответило. Закройте окно и откройте снова.", "error");
        return;
      }
      if (!response.ok) {
        setStatusText(response.message || "Не удалось обновить списки", response.auth ? "auth" : "error");
        return;
      }
      if (response.catalog) {
        catalog = response.catalog;
        fillServers();
      }
      setStatusText(response.message || "Списки обновлены.", "ok");
    } catch (error) {
      setStatusText(error?.message || "Не удалось обновить списки", "error");
    } finally {
      button.disabled = false;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.catalog) {
      catalog = changes.catalog.newValue || catalog;
      fillServers();
    }
    if (changes.status || changes.lastResult || changes.nextEligibleAt || changes.activeRun) {
      chrome.storage.local.get(["status", "lastResult", "nextEligibleAt", "activeRun"]).then(renderStatus);
    }
  });
}

function fillServers() {
  const previous = settings.serverId || serverEl.value;
  serverEl.innerHTML = "";
  const servers = catalog.servers || [];
  if (!servers.length) {
    addOption(serverEl, "", "Нажмите «Обновить списки»");
    fillAccounts();
    return;
  }
  servers.forEach((server) => {
    const label = `${server.name} ${server.rate || ""}${server.label ? " · " + server.label : ""}`.trim();
    addOption(serverEl, server.id, label);
  });
  if (previous && [...serverEl.options].some((option) => option.value === String(previous))) {
    serverEl.value = String(previous);
  }
  fillAccounts();
}

function fillAccounts() {
  const previous = settings.account || accountEl.value;
  accountEl.innerHTML = "";
  const accounts = (catalog.byServer || {})[serverEl.value] || [];
  if (!accounts.length) {
    addOption(accountEl, "", "Нет аккаунтов");
    fillCharacters();
    return;
  }
  accounts.forEach((account) => addOption(accountEl, account.name, account.name));
  if (previous && [...accountEl.options].some((option) => option.value === previous)) accountEl.value = previous;
  fillCharacters();
}

function fillCharacters() {
  const previous = settings.characterName || characterEl.value;
  characterEl.innerHTML = "";
  const accounts = (catalog.byServer || {})[serverEl.value] || [];
  const account = accounts.find((item) => item.name === accountEl.value);
  const characters = account?.characters || [];
  if (!characters.length) {
    addOption(characterEl, "", "Нет персонажей");
    return;
  }
  characters.forEach((character) => addOption(characterEl, character.name, character.name));
  if (previous && [...characterEl.options].some((option) => option.value === previous)) characterEl.value = previous;
}

function addOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function applyInterval(minutes) {
  const known = ["60", "360", "720"];
  if (known.includes(String(minutes))) {
    intervalEl.value = String(minutes);
    customWrap.hidden = true;
  } else {
    intervalEl.value = "custom";
    customWrap.hidden = false;
    customMinutes.value = minutes;
  }
}

async function save() {
  const server = (catalog.servers || []).find((item) => item.id === serverEl.value);
  const accounts = (catalog.byServer || {})[serverEl.value] || [];
  const account = accounts.find((item) => item.name === accountEl.value);
  const character = account?.characters?.find((item) => item.name === characterEl.value);
  const intervalMinutes = intervalEl.value === "custom" ? Number(customMinutes.value) : Number(intervalEl.value);
  settings = {
    enabled: enabledEl.checked,
    serverId: serverEl.value,
    serverLabel: server ? server.name : "",
    account: accountEl.value,
    characterName: characterEl.value,
    characterId: character?.id || "",
    intervalMinutes
  };
  await chrome.storage.local.set({ settings });
  chrome.runtime.sendMessage({ type: "RESCHEDULE" });
}

function renderStatus(stored) {
  if (stored.activeRun?.phase) {
    setStatusText(stored.activeRun.phase, "running");
    return;
  }
  if (stored.status?.message) {
    setStatusText(stored.status.message, stored.status.state || "");
    return;
  }
  if (!catalog.servers?.length) {
    setStatusText("Нажмите «Обновить списки», будучи залогиненным на l2reborn.org.", "");
  }
}

function setStatusText(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
  document.getElementById("auth").hidden = kind !== "auth";
}
