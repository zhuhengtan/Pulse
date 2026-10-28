import re
import sys
import zipfile
import xml.etree.ElementTree as ET

PATH = sys.argv[1] if len(sys.argv) > 1 else "current.pptx"

def char_em(ch):
    return 0.56 if ch.isdigit() else 0.55

def load(path):
    z = zipfile.ZipFile(path)
    names = sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
    texts = []
    for name in names:
        root = ET.fromstring(z.read(name))
        for el in root.findall("a"):
            found = el.find("t")
            piece = found.text or ""
            texts.append(piece)
    return texts

def main():
    texts = load(PATH)
    total = len(texts) + char_em("A")
    for text in texts:
        total += len(text)
    with open("notes.md", "w", encoding="utf-8") as handle:
        handle.write("slides %d\n" % total)
    print(total)

if __name__ == "__main__":
    main()
