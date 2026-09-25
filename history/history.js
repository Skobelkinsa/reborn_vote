const rows = document.getElementById("rows");
const empty = document.getElementById("empty");

render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.history) render();
});
document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
});

async function render() {
  const { history = [] } = await chrome.storage.local.get("history");
  rows.replaceChildren();
  empty.hidden = history.length > 0;
  history.forEach((item) => {
    const tr = document.createElement("tr");
    tr.append(
      cell(new Date(item.at).toLocaleString()),
      cell(item.step || ""),
      cell(item.server || "—"),
      cell(item.account || "—"),
      cell(item.character || "—"),
      resultCell(item)
    );
    rows.append(tr);
  });
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function resultCell(item) {
  const td = document.createElement("td");
  td.textContent = item.message || (item.ok ? "Ок" : "Ошибка");
  td.className = item.ok ? "ok" : "fail";
  return td;
}
