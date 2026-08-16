const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'src', 'generated', 'prisma');
const target = path.join(projectRoot, 'dist', 'generated', 'prisma');

if (!fs.existsSync(source)) {
  throw new Error(`Generated Prisma client not found at ${source}. Run prisma generate first.`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });

console.log(`Copied generated Prisma client to ${path.relative(projectRoot, target)}`);
