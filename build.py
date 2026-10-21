"""Build Writers Board into dist/ (main.js, styles.css, manifest.json). No dependencies: python3 build.py"""
import pathlib, shutil, base64
R = pathlib.Path(__file__).resolve().parent; src = R / 'src'; out = R / 'dist'; out.mkdir(exist_ok=True)
read = lambda f: (src / f).read_text(encoding='utf-8')
main = ("'use strict';\nconst { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon } = require('obsidian');\n\n"
        + '\n'.join(read(f) for f in ['notes.js', 'achievements.js', 'banner.js', 'main.js']) + '\nmodule.exports = WritersBoard;\n')
(out / 'main.js').write_text(main, encoding='utf-8')
css = read('styles.css')
for key, f in (('WB_DUSK', 'bg-warm.jpg'), ('WB_NORTH', 'bg-north.jpg')):   # unlockable backgrounds, embedded so the plugin stays 3 files
    css = css.replace(key, 'data:image/jpeg;base64,' + base64.b64encode((src / f).read_bytes()).decode())
(out / 'styles.css').write_text(css, encoding='utf-8')
shutil.copy(R / 'manifest.json', out / 'manifest.json')
print('dist/ ready: main.js, manifest.json, styles.css')
