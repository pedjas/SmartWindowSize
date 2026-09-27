/** Displays basic SmartWindowSize identity information and returns focus to its browser window on request. */
import { APP_VERSION } from "../core/app-version.js";
import { request, installClientErrors, runClientAction } from "../core/client.js";


/** Browser tab identifier optionally supplied by the context-menu owner. @type {number} */
const tabParameter = new URL(location.href).searchParams.get("tabId");

/** Optional source tab; an empty query value is not tab zero. @type {number} */
const tabId = tabParameter ? Number(tabParameter) : NaN;


/** Initializes the caption and version without repeating the application name in the dialog body. */
document.title = `SmartWindowSize ${APP_VERSION} — About`;
installClientErrors(document.querySelector("#error"));
document.querySelector("#version").textContent = `Version ${APP_VERSION}`;
for (const button of document.querySelectorAll("button")) button.title ||= button.textContent.trim();
document.querySelector("#ok").addEventListener("click", () => window.close());
document.querySelector("#open-readme").addEventListener("click", async (event) => {
  event.preventDefault();
  await runClientAction("Open local README", () => request({ type: "open-local-readme" }));
});
document.querySelector("#bring-to-front").disabled = !Number.isInteger(tabId);
document.querySelector("#bring-to-front").addEventListener("click", async () => {
  await runClientAction("Focus source window", () => request({ type: "focus-window", tabId }));
});
