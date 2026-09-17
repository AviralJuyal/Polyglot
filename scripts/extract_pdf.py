"""Extract selectable PDF text. The caller supplies a size-limited PDF on stdin."""
import io
import sys

from pypdf import PdfReader


def main() -> None:
    reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()), strict=False)
    if len(reader.pages) > 80:
        raise ValueError("PDF exceeds the 80-page limit")
    print("\n\n".join(page.extract_text() or "" for page in reader.pages))


if __name__ == "__main__":
    main()
