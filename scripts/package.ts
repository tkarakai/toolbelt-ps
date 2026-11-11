import config from "../release.config";
for (const path of await config.products.plugin.build()) console.log(path);
