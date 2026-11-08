import Corestore from 'corestore'
import Localdrive from 'localdrive'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

export async function tmpDir (prefix = 'syncd-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function tmpStore () {
  const dir = await tmpDir('syncd-store-')
  const store = new Corestore(dir)
  await store.ready()
  return { store, dir }
}

export async function tmpFolder (files = {}) {
  const dir = await tmpDir('syncd-folder-')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), content)
  }
  return { dir, drive: new Localdrive(dir) }
}

export async function listFiles (dir) {
  const out = []
  async function walk (d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(relative(dir, p))
    }
  }
  await walk(dir)
  return out.sort()
}
