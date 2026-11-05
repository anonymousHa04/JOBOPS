// Command gateway is the front door of JobOps in Kubernetes: it serves the built web UI
// (ui/dist) and passes /api/* to the API with the /api prefix removed, the same as the Vite
// dev server's proxy. GET /health answers ok (the Kubernetes probes use it).
//
//	gateway -addr 0.0.0.0:8080 -ui /app/ui/dist -api http://api:3000
package main

import (
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", env("GATEWAY_ADDR", "127.0.0.1:8080"), "listen address")
	ui := flag.String("ui", env("GATEWAY_UI_DIR", "ui/dist"), "built UI folder (npm run ui:build)")
	api := flag.String("api", env("JOBOPS_API", "http://127.0.0.1:3000"), "JobOps API base URL")
	flag.Parse()

	h, err := handler(*ui, *api)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: *addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("gateway on %s (ui %s, api %s)", *addr, *ui, *api)
	log.Fatal(srv.ListenAndServe())
}

func handler(uiDir, apiURL string) (http.Handler, error) {
	target, err := url.Parse(apiURL)
	if err != nil {
		return nil, err
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, "/api")
			r.Out.URL.RawPath = ""
			if r.Out.URL.Path == "" {
				r.Out.URL.Path = "/"
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("api %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, `{"error":"the JobOps API is not answering"}`, http.StatusBadGateway)
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/api/", logWrites(proxy))
	mux.Handle("/", spa(uiDir))
	return mux, nil
}

// statusWriter remembers the status code the proxy wrote.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// logWrites logs every request that changes something (not GET/HEAD, which the UI polls every
// 15 s) and every failed request: method, path, status, time. bin/jobops watch shows these.
func logWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			if sw.status < 400 {
				return
			}
		}
		log.Printf("%s %s %d %d ms", r.Method, r.URL.Path, sw.status, time.Since(start).Milliseconds())
	})
}

// spa serves files from dir; a path with no such file gets index.html (the UI has one page).
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.FromSlash(filepath.Clean("/"+r.URL.Path)))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			w.Header().Set("cache-control", "no-cache")
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
