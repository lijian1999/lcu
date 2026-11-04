// The tool descriptions the fake upstream (upstream-fixture.mjs) reports, in one module shared
// by the fixture subprocess and the tests that assert on what the relay lists, so the two
// cannot drift. The js text mirrors the real upstream's shape — its opening sentence plus the
// usage rules production showed the model needs (see relay.mjs's JS_DESCRIPTION_PREFIX).
export const FIXTURE_JS_DESCRIPTION = 'Control native apps or browsers by running JavaScript in the cua_repl computer-use sandbox. On the first invocation, execute exactly one documented API call (such as `await cua.getState()`); its result carries the full guide. Write output with nodeRepl.write(). Browser APIs are disabled.';
export const FIXTURE_JS_RESET_DESCRIPTION = 'Fixture reset description.';