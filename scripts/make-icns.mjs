import fs from "node:fs";

const entries = [
  ["icp4", "/private/tmp/csm-icon.iconset/icon_16x16.png"],
  ["icp5", "/private/tmp/csm-icon.iconset/icon_32x32.png"],
  ["icp6", "/private/tmp/csm-icon.iconset/icon_32x32@2x.png"],
  ["ic07", "/private/tmp/csm-icon.iconset/icon_128x128.png"],
  ["ic08", "/private/tmp/csm-icon.iconset/icon_256x256.png"],
  ["ic09", "/private/tmp/csm-icon.iconset/icon_512x512.png"],
  ["ic10", "/private/tmp/csm-icon.iconset/icon_512x512@2x.png"]
];

const chunks = entries.map(([type, file]) => {
  const png = fs.readFileSync(file);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});

const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(totalLength, 4);

fs.writeFileSync("src-tauri/icons/icon.icns", Buffer.concat([header, ...chunks]));
console.log("src-tauri/icons/icon.icns");
