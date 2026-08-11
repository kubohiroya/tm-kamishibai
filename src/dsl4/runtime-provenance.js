// SPDX-License-Identifier: MPL-2.0

/**
 * The source components that are composed into the DSL 4.0 runtime extension.
 * Keep this list close to the bundle so a downloaded extension remains
 * attributable even when a host shows the minified, composed source.
 */
export const dsl4RuntimeProvenance = Object.freeze([
  {
    title: 'Kamishibai DSL 4.0 Runtime',
    source: 'tmpose-kamishibai',
    version: '4.0.0-dev',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'Asset Manager',
    source: '@kubohiroya/turbowarp-asset-manager',
    version: '0.10.0',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'Async Input',
    source: '@kubohiroya/turbowarp-async-input',
    version: '0.3.0',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'Bubble',
    source: '@kubohiroya/turbowarp-bubble',
    version: '0.4.0',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'Runtime Expression',
    source: '@kubohiroya/turbowarp-runtime-expression',
    version: '0.3.0',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'SVG Text',
    source: '@kubohiroya/turbowarp-svg-text',
    version: '0.4.0',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'TMPose',
    source: '@kubohiroya/turbowarp-tmpose',
    version: '1.7.3',
    copyright: 'Hiroya Kubo',
    license: 'MPL-2.0',
  },
  {
    title: 'Teachable Machine Pose',
    source: '@teachablemachine/pose',
    version: '0.8.3',
    copyright: 'Google LLC',
    license: 'Apache-2.0',
  },
  {
    title: 'TensorFlow.js',
    source: '@tensorflow/tfjs',
    version: '1.3.1',
    copyright: 'Google LLC',
    license: 'Apache-2.0',
  },
  {
    title: 'PoseNet MobileNetV1 model',
    source: '@tensorflow-models/posenet',
    version: '2.2.2',
    copyright: 'TensorFlow Authors',
    license: 'Apache-2.0',
  },
]);

/**
 * Produce a legal comment that survives minification and is shown by hosts
 * which display the source of an embedded extension.
 *
 * @returns {string}
 */
export function formatDsl4RuntimeProvenanceComment() {
  const lines = [
    '/*!',
    ' * Kamishibai DSL 4.0 Runtime — composed source notices',
    ' * Copyright © 2026 Hiroya Kubo.',
    ' *',
    ' * Original component title / copyright / license:',
  ];
  for (const component of dsl4RuntimeProvenance) {
    lines.push(
      ` * - ${component.title} — ${component.copyright} — ${component.license} — ${component.source}@${component.version}`,
    );
  }
  lines.push(
    ' *',
    ' * Full license texts and source revisions are recorded in LICENSES.md.',
    ' */',
  );
  return `${lines.join('\n')}\n`;
}

export function formatDsl4RuntimeExtensionHeader() {
  return [
    '// Name: Kamishibai DSL 4.0 Runtime',
    '// ID: kubohiroyakamishibai4',
    '// Description: Run a self-contained Participatory AI Kamishibai DSL 4.0 story.',
    '// By: Hiroya Kubo',
    '// License: MPL-2.0',
    '',
    formatDsl4RuntimeProvenanceComment().trimEnd(),
    '',
  ].join('\n');
}
