/**
 * One asset's content, as the converter carries it between reading and writing.
 *
 * Three readers produce it — the local snapshot, the SB3 project, and a remote destination — and
 * the converter compares and repacks what they return without caring which one it came from, so
 * they share this shape rather than each describing its own.
 */
export interface AssetMaterialFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface AssetMaterial {
  files: readonly AssetMaterialFile[];
  /**
   * A recognition model that stays zipped: it materializes as the single archive file rather than
   * the three model files, and is copied rather than repacked.
   */
  opaquePoseArchive?: boolean;
}
