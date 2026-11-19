# Firestore rules tests

These checks use the Firebase rules emulator and synthetic people only.

1. From this directory: `npm install`
2. In another terminal, from the repository root:

       npx --yes firebase-tools emulators:start --only firestore --project demo-family-tree

   Or from this folder, if you already have `firebase-tools` installed:

       npx firebase emulators:start --only firestore --project demo-family-tree

   The tests expect the emulator on `127.0.0.1:8181`.

3. Run:

       node test.mjs

By default the suite fills `templates/firestore.rules.template` with
`owner@example.com` and archive IDs `familytree` / `familytree_log`.
To test a folder produced by `setup.mjs`:

    RULES_FILE=../deploy-my-proj/firestore.rules \
    OSR_SUPER_ADMIN=you@example.com \
    OSR_ARCHIVE_ID=familytree \
    node test.mjs
