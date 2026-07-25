import {stat} from 'node:fs/promises';

async function modificationTime(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function outputsAreUpToDate(inputPaths, outputPaths, {force = false} = {}) {
  if (force || inputPaths.length === 0 || outputPaths.length === 0) {
    return false;
  }

  const [inputTimes, outputTimes] = await Promise.all([
    Promise.all(inputPaths.map(modificationTime)),
    Promise.all(outputPaths.map(modificationTime)),
  ]);
  if (inputTimes.includes(null) || outputTimes.includes(null)) {
    return false;
  }

  return Math.max(...inputTimes) <= Math.min(...outputTimes);
}
