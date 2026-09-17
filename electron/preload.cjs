const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // expose secure APIs here later
});
