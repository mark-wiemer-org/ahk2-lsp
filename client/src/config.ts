//* IDE-specific config functions

import * as vscode from 'vscode';
import { CfgKey, configPrefix } from '../../util/src/config';

/** Get the root config object currently persisted in the IDE */
export function getConfigRoot() {
	return vscode.workspace.getConfiguration(configPrefix);
}

/** Get the config value currently persisted in the IDE */
export function getConfigIDE<T = unknown>(
	key: CfgKey,
	defaultValue: T,
): typeof defaultValue {
	const rawResult = getConfigRoot().get<T>(key);
	if (rawResult === undefined) return defaultValue;
	return rawResult;
}

export function updateConfig<T>(
	configKey: CfgKey,
	value: T,
	isProperty: boolean,
	configTarget: vscode.ConfigurationTarget | undefined = undefined,
	outputChannel: vscode.OutputChannel | undefined = undefined,
) {
	const log = outputChannel?.appendLine;
	log?.(
		`updateConfig(${configKey}, ${JSON.stringify(value)}, ${isProperty}, ${configTarget}`,
	);
	/**
	 * The key to the corresponding object for this config value.
	 * Note that we can only update objects, not individual properties.
	 */
	const configObjectKey = isProperty
		? configKey.substring(0, configKey.lastIndexOf('.'))
		: configKey;
	const lastKeyPart = configKey.substring(configKey.lastIndexOf('.') + 1);
	const configRoot = getConfigRoot();
	log?.(`Fetching ${configPrefix}.${configObjectKey}`);
	const currentObjectValue = configRoot.get(configObjectKey, {});
	log?.(`currentObjectValue: ${JSON.stringify(currentObjectValue)}`);
	const newObjectValue = isProperty
		? {
				...currentObjectValue,
				[lastKeyPart]: value,
			}
		: {
				...currentObjectValue,
				...value,
			};
	log?.(`newObjectValue: ${JSON.stringify(newObjectValue)}`);
	configRoot.update(configObjectKey, newObjectValue, configTarget);
}
