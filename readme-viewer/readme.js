/**
 * Loads the packaged user manual into a read-only SmartWindowSize browser tab.
 * This viewer is opened by the About dialog and Configuration page.
 */

import { APP_VERSION } from "../core/app-version.js";
import { installClientErrors, runClientAction } from "../core/client.js";


/** Element that displays the plain-text installation guide. @type {HTMLPreElement} */
const readme = document.querySelector("#readme");

installClientErrors(document.querySelector("#error"));
document.title = `SmartWindowSize ${APP_VERSION} — User manual`;
document.querySelector("#application-title").textContent = `SmartWindowSize ${APP_VERSION} — User manual`;


/** Downloads the packaged README using an extension-local URL and displays it as text. @returns {Promise<void>} Completes after text is rendered. */
async function loadLocalReadme() {
  const response = await fetch(chrome.runtime.getURL("user-manual.txt"));
  if (!response.ok) throw new Error("The packaged user manual could not be loaded.");
  readme.textContent = await response.text();
}


runClientAction("Load user manual", loadLocalReadme);
