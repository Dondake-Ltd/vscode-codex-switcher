declare const acquireVsCodeApi: undefined | (() => {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
});

export type VsCodeApiLike = {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

export function getVsCodeApi(): VsCodeApiLike {
  if (typeof acquireVsCodeApi === 'function') {
    return acquireVsCodeApi();
  }

  return {
    postMessage: (message: unknown) => {
      console.info('VS Code API unavailable in dashboard preview.', message);
    },
    setState: () => undefined,
    getState: () => undefined
  };
}
