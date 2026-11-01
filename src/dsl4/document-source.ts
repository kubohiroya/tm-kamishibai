// SPDX-License-Identifier: MPL-2.0

import type {DocumentSourceOwnerOptions} from '@kubohiroya/turbowarp-document-source';
import {kamishibaiDocumentOwner} from './embedded-yaml-document-owner.js';

interface DocumentSourceStartupEnvironment {
  readonly TW_PLUS_DOCUMENT_SOURCE?: unknown;
  readonly location?: {readonly search?: unknown};
}

/** Read only the launch environment; document or project data cannot enable this capability. */
export function readKamishibaiDocumentSourceFlag(
  environment: DocumentSourceStartupEnvironment = globalThis as DocumentSourceStartupEnvironment,
): boolean {
  if (environment.TW_PLUS_DOCUMENT_SOURCE === true) return true;
  const search = environment.location?.search;
  return (
    typeof search === 'string' && new URLSearchParams(search).get('twPlusDocumentSource') === '1'
  );
}

/** Fixed once when the owner runtime starts, so an opened project cannot widen it. */
export const documentSourceEnabledAtStartup = readKamishibaiDocumentSourceFlag();

/** The owner's name for this document wherever the generic data source dialog shows it. */
export const kamishibaiDocumentSourceDialogTitle = Object.freeze({
  ja: '台本データ',
  en: 'Script data',
});

const BUNDLE = 'kubohiroyakamishibai4';
const COMPONENT = 'kubohiroyakamishibairuntime4';

const error = (code: string, message: string) => Object.assign(new Error(message), {code});

/**
 * URL locations persist under the loaded owner extension, so a standard SB3 save keeps them.
 * An unused extension storage entry would be dropped, which is why this follows the owner form.
 */
export function kamishibaiDocumentSourceStorageId(project: Record<string, unknown>): string {
  const selected = kamishibaiDocumentOwner(project);
  if (!selected)
    throw error('SOURCE_STORAGE_INVALID', 'This project has no Kamishibai document owner.');
  return selected.form === 'bundled' ? BUNDLE : COMPONENT;
}

type SourceReplacement = (
  project: Record<string, unknown>,
  source: string,
) => Promise<{project: Record<string, unknown>; component: {source: {text: string}}}>;

export interface KamishibaiDocumentSourceOwnerInput {
  /** Validates the source and updates only this owner's caller-owned project copy. */
  readonly replaceSource: SourceReplacement;
  /** The host's own network capability; the owner never reaches for an ambient one. */
  readonly fetch?: DocumentSourceOwnerOptions['fetch'];
}

/**
 * Describe this owner to the shared data source registry. The registry fetches, guards the
 * editing session and applies the project difference; the owner only validates and rewrites
 * its own component.
 */
export function createKamishibaiDocumentSourceOwnerOptions(
  input: KamishibaiDocumentSourceOwnerInput,
): DocumentSourceOwnerOptions {
  if (typeof input?.replaceSource !== 'function')
    throw error('SOURCE_CANDIDATE_INVALID', 'An owner source replacement is required.');
  const options: DocumentSourceOwnerOptions = {
    sourceStorageId: kamishibaiDocumentSourceStorageId,
    dialogTitle: kamishibaiDocumentSourceDialogTitle,
    ...(input.fetch ? {fetch: input.fetch} : {}),
    async buildSourceCandidate({project, source}) {
      const built = await input.replaceSource(project, source);
      // The saved text must be exactly the validated text, so reject sources we would rewrite.
      if (built.component.source.text !== source)
        throw error(
          'SOURCE_NOT_CANONICAL',
          'This document source must use LF line endings without a byte order mark.',
        );
      return {project: built.project, source};
    },
  };
  return Object.freeze(options);
}
