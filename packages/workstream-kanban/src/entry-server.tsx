import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { getRouterManifest } from "@tanstack/react-start/router-manifest";
import { router } from "./router";

export default createStartHandler({
  router,
  getRouterManifest,
})(defaultStreamHandler);
