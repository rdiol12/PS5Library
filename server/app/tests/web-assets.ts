import { readFile } from 'node:fs/promises';

export const webScripts = [
  'app-library.js',
  'app-profile.js',
  'app-manager.js',
  'app-details.js',
  'app.js',
];

export const webStyles = [
  'style-base.css',
  'style-operational.css',
  'style-storefront.css',
  'style-manager.css',
  'style-system.css',
  'style-consoles.css',
  'style-saves.css',
];

const readAssets = async (files: string[]) =>
  (await Promise.all(files.map((file) => readFile(`app/public/${file}`, 'utf8')))).join('\n');

export const readWebAppSource = () => readAssets(webScripts);
export const readWebStyles = () => readAssets(webStyles);
