# Custom MIBs Directory

Put your custom MIB files (`.mib`, `.my`, `.txt`) in this folder.

On application startup, they will be automatically:
1. Copied to the active MIB storage directory (`./data/mibs/` or packaged `userData/data/mibs/`).
2. Parsed and registered in the database.
3. Available under the MIB manager and device options.

For packaged builds, this folder is bundled directly into the installer as a preloaded asset.
