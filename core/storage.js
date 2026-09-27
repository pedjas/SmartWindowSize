import { CONFIG_SCHEMA_VERSION, createDefaultConfig, normalizeConfig, validateConfigImport } from "./config.js";
import { pruneExpiredRules } from "./rule-updater.js";


/**
 * Persists SmartWindowSize configuration in chrome.storage.local.
 * Configuration creation, validation, migration, import, and reset flow through this module.
 */

/** chrome.storage.local key containing the complete persisted configuration. @type {string} */
const STORAGE_KEY = "smartWindowSizeConfig";


/** Promise chain that serializes service-worker configuration updates. @type {Promise<void>} */
let configurationUpdateQueue = Promise.resolve();


/**
 * Adds work to the serialized configuration-update queue.
 *
 * @template T
 * @param {() => Promise<T>} operation One configuration operation.
 * @returns {Promise<T>} Result produced after earlier configuration work completes.
 */
function enqueueConfigurationOperation(operation) {
  const queuedOperation = configurationUpdateQueue.then(operation, operation);
  configurationUpdateQueue = queuedOperation.then(() => undefined, () => undefined);
  return queuedOperation;
}


/**
 * Reads and normalizes the most recently persisted configuration.
 *
 * @returns {Promise<{saved: unknown, config: object}>} Stored source and its normalized configuration.
 */
async function readCurrentConfig() {
  const { [STORAGE_KEY]: saved } = await chrome.storage.local.get(STORAGE_KEY);
  return { saved, config: migrateConfig(saved) };
}


/** Loads and migrates the stored configuration when needed. @returns {Promise<object>} Normalized current-schema configuration. */
export async function loadConfig() {
  return enqueueConfigurationOperation(async () => {
    const { saved, config } = await readCurrentConfig();
    const pruning = pruneExpiredRules(config);
    if (!saved || saved.schemaVersion !== CONFIG_SCHEMA_VERSION || pruning.changed || JSON.stringify(saved) !== JSON.stringify(pruning.config)) {
      await chrome.storage.local.set({ [STORAGE_KEY]: pruning.config });
    }
    return pruning.config;
  });
}


/** Validates and saves configuration to browser-local storage. @param {object} config Candidate configuration. @returns {Promise<object>} Saved normalized configuration. */
export async function saveConfig(config) {
  return enqueueConfigurationOperation(async () => {
    const normalized = normalizeConfig(config);
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  });
}


/**
 * Changes the latest stored configuration without allowing concurrent events to overwrite rules.
 *
 * Returning undefined from the updater leaves the configuration unchanged.
 *
 * @param {(config: object) => object|undefined|Promise<object|undefined>} updater Receives the latest normalized configuration.
 * @returns {Promise<object>} The saved configuration, or the current configuration when unchanged.
 */
export async function updateConfig(updater) {
  return enqueueConfigurationOperation(async () => {
    const { config } = await readCurrentConfig();
    const candidate = await updater(config);
    if (candidate === undefined) return config;
    const normalized = normalizeConfig(candidate);
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  });
}


/** Migrates a stored configuration into the current schema without discarding valid rules. @param {unknown} raw Stored configuration. @returns {object} Normalized current-schema configuration. */
export function migrateConfig(raw) {
  if (!raw || typeof raw !== "object") return createDefaultConfig();

  // Normalization removes invalid or duplicate rules and restores schema defaults.
  return normalizeConfig({ ...raw, schemaVersion: CONFIG_SCHEMA_VERSION });
}


/** Validates and replaces all stored configuration, for example after import. @param {unknown} candidate Imported configuration. @returns {Promise<object>} Saved normalized configuration. */
export async function replaceConfig(candidate) {
  const normalized = validateConfigImport(candidate);
  return saveConfig(normalized);
}


/** Resets local configuration to SmartWindowSize defaults. @returns {Promise<object>} Saved default configuration. */
export async function resetConfig() {
  const config = createDefaultConfig();
  await saveConfig(config);
  return config;
}
