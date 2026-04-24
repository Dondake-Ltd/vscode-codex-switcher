"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVsCodeApi = getVsCodeApi;
function getVsCodeApi() {
    if (typeof acquireVsCodeApi === 'function') {
        return acquireVsCodeApi();
    }
    return {
        postMessage: (message) => {
            console.info('VS Code API unavailable in dashboard preview.', message);
        },
        setState: () => undefined,
        getState: () => undefined
    };
}
//# sourceMappingURL=vscode.js.map