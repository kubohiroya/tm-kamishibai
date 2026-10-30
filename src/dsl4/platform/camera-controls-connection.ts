import {cameraSourceRuntimeKey} from '@kubohiroya/turbowarp-camera-source/runtime';
import type {Dsl4CameraControlsController} from './camera-preview-controls.js';

export interface Dsl4CameraControlsSource {
  registerCameraControls(options: {
    owner: string;
    cameraId: string;
    locale: string;
    port?: unknown;
    labels?: Readonly<Record<string, string>>;
    mirroring?: string;
  }): Dsl4CameraControlsController | null;
}

/** Read Camera Source's public runtime meeting point, including static bundle members. */
export function readDsl4CameraControlsSource(runtime: unknown): Dsl4CameraControlsSource | null {
  if (typeof runtime !== 'object' || runtime === null) return null;
  try {
    const source = Reflect.get(runtime, cameraSourceRuntimeKey) as unknown;
    if (typeof source !== 'object' || source === null) return null;
    return typeof Reflect.get(source, 'registerCameraControls') === 'function'
      ? (source as Dsl4CameraControlsSource)
      : null;
  } catch {
    // A host's optional capability getter cannot prevent the legacy permission UI from working.
    return null;
  }
}

/** Keep an existing permission UI until the shared replacement has started successfully. */
export function connectDsl4TitleCameraControls(options: {
  source: Dsl4CameraControlsSource;
  locale: string;
  disposeFallback(): void;
  onError(error: unknown): void;
}): Dsl4CameraControlsController | null {
  let control: Dsl4CameraControlsController | null = null;
  try {
    control = options.source.registerCameraControls({
      owner: 'kamishibai-title',
      cameraId: 'pose',
      locale: options.locale,
    });
    if (!control) return null;
    control.start();
    options.disposeFallback();
  } catch (error) {
    try {
      control?.dispose();
    } catch {
      // Preserve the registration failure while leaving the existing permission UI available.
    }
    options.onError(error);
    return null;
  }
  return control;
}
