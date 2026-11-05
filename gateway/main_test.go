package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestGateway(t *testing.T) {
	var gotPath string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.RequestURI()
		w.Write([]byte("from api"))
	}))
	defer api.Close()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>ui</html>"), 0o644)
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("js"), 0o644)

	h, err := handler(dir, api.URL)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	cases := []struct{ path, body string }{
		{"/api/ui/board?x=1", "from api"},
		{"/assets/app.js", "js"},
		{"/", "<html>ui</html>"},
		{"/some/view", "<html>ui</html>"},
		{"/../../etc/passwd", "<html>ui</html>"},
		{"/health", `{"status":"ok"}`},
	}
	for _, c := range cases {
		res, err := http.Get(srv.URL + c.path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(b) != c.body {
			t.Errorf("%s: got %q, want %q", c.path, b, c.body)
		}
	}
	if gotPath != "/ui/board?x=1" {
		t.Errorf("api saw %q, want /ui/board?x=1", gotPath)
	}
}
