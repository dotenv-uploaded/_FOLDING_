import type { CodegateApi } from './index';

declare global {
  interface Window {
    codegate: CodegateApi;
  }
}

export {};
