chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (typeof message?.url !== "string") return false;
  if (message.type === "probe-image") {
    fetch(message.url, { method: "HEAD" })
      .then(async (response) => {
        let contentType = response.headers.get("content-type") || "";
        if (!/image\/(?:gif|webp)/i.test(contentType)) {
          const sample = await fetch(message.url, { headers: { Range: "bytes=0-31" } });
          contentType = sample.headers.get("content-type") || contentType;
          sample.body?.cancel();
        }
        sendResponse({ ok: /image\/(?:gif|webp)/i.test(contentType), contentType });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type !== "read-image") return false;
  fetch(message.url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return {
        ok: true,
        data: btoa(binary),
        encoding: "base64",
        contentType: response.headers.get("content-type") || "image/gif"
      };
    })
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
