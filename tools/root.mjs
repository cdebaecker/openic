// Working layout: the repository sits next to the disk images and ../work.
// IC_ROOT overrides the parent folder.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// True when the module at `url` (its import.meta.url) is the script node was started with.
// Compares URLs, so it holds on Windows too (argv[1] is a D:\... path there).
export const isMain = (url) => !!process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href;

export const root = (process.env.IC_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')).replace(/\\/g, '/');
