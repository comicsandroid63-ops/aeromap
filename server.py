import http.server
import os

PORT = 3000
DIR = os.path.join(os.path.dirname(__file__), "public")

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) or os.path.isdir(path):
            self.path = "/index.html"
        return super().do_GET()

os.chdir(DIR)
server = http.server.HTTPServer(("0.0.0.0", PORT), SPAHandler)
print(f"Server running on http://localhost:{PORT}")
server.serve_forever()
