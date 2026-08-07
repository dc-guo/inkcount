/* InkCount entry point. All logic lives in ./src/ modules; this file only
 * boots the UI when the app page is present (test pages import modules
 * directly and never see the UI layer). */
import { initUI } from './src/ui.js';

if (document.getElementById('app')) initUI();
