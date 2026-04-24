"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const preact_1 = require("preact");
const app_1 = require("./src/app");
require("./src/styles.css");
const root = document.getElementById('root');
if (!root) {
    throw new Error('Usage dashboard root element not found.');
}
(0, preact_1.render)(<app_1.App />, root);
//# sourceMappingURL=main.js.map