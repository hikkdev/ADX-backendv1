import path from 'path';
import dotenv from 'dotenv';

// `import 'dotenv/config'` resolves .env against process.cwd(), so launching
// the app from anywhere other than the backend root (e.g. the repo root, or a
// VS Code task with a different cwd) silently loads nothing: DATABASE_URL ends
// up undefined and `pg` falls back to its no-password defaults, failing with
// "fe_sendauth: no password supplied". Resolve against this file instead so the
// launch directory never matters. __dirname is src/config in dev and
// dist/config after a build — ../.. is the backend root in both.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
