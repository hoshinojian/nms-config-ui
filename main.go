// nms-config-ui —— NMS 配置文件上传/下发的自用图形小工具。
//
// 单二进制：内嵌单页 UI（web/），/api/* 反向代理到 NMS（同源免 CORS）。
// 上游 NMS API 无鉴权（单管理员口径），本工具默认只监听回环地址，
// 远程使用走 SSH 端口转发（见 README）。
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

// newMux 装配路由：/api/* 反代上游，其余走内嵌静态 UI。
func newMux(up *url.URL) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			r.URL.Scheme = up.Scheme
			r.URL.Host = up.Host
			r.URL.Path = singleJoiningSlash(up.Path, r.URL.Path)
			r.Host = up.Host
		},
		// 上游不可达时给前端一个稳定的 JSON 形态（页面可直接展示 message）。
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, `{"code":502,"message":"upstream 不可达：%s"}`, err.Error())
		},
	})
	static, _ := fs.Sub(webFS, "web")
	mux.Handle("/", http.FileServer(http.FS(static)))
	return mux
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8090", "监听地址（上游无鉴权，勿裸暴露到非回环）")
	upstream := flag.String("upstream", "http://127.0.0.1:8080", "NMS API 基址")
	flag.Parse()

	up, err := url.Parse(*upstream)
	if err != nil || up.Scheme == "" || up.Host == "" {
		fmt.Fprintf(os.Stderr, "非法 -upstream %q\n", *upstream)
		os.Exit(2)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           newMux(up),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("nms-config-ui listening on http://%s (upstream %s)", *addr, *upstream)
	log.Fatal(srv.ListenAndServe())
}

// singleJoiningSlash 与 httputil 单行代理默认拼接一致；up.Path 通常为空。
func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	}
	return a + b
}
