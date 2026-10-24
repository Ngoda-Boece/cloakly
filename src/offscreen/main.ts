import { analyze, getStatus, startLoading } from "../ai/runtime";
import type { AnalyzeResponse, Envelope } from "../ai/protocol";

chrome.runtime.onMessage.addListener((message: Envelope, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  switch (message.type) {
    case "status":
      sendResponse(getStatus());
      return false;
    case "load":
      startLoading(message);
      sendResponse(getStatus());
      return false;
    case "analyze":
      analyze(message.text, message)
        .then((findings): AnalyzeResponse => ({ ok: true, findings }))
        .catch((error: unknown): AnalyzeResponse => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then(sendResponse);
      return true;
  }
});
