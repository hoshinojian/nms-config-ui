package main

import (
	"encoding/json"
	"net/http"
)

// /ctl 控制面响应（小工具自用，形态保持 {code?,message?} 与上游错误风格一致）。
func writeJSONErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"code": code, "message": msg})
}

func writeJSONOK(w http.ResponseWriter, body map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(body)
}
