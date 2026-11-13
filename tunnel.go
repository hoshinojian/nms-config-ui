// SSH 隧道连接管理：页面输入 NMS 宿主机 + SSH 账密，工具建立隧道并经其反代 /api。
// 密码只存进程内存，不落盘、不写日志；断开或重连即弃。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type tunnelManager struct {
	mu     sync.Mutex
	client *ssh.Client
	host   string // SSH 入口 host:port
	target string // 隧道对端（NMS API，宿主机视角）
}

type connectBody struct {
	Host     string `json:"host"`     // ip 或 ip:port（缺省补 :22）
	User     string `json:"user"`     // SSH 用户
	Password string `json:"password"` // SSH 密码（仅内存）
	Target   string `json:"target"`   // NMS API（宿主机视角，缺省 127.0.0.1:8080）
}

func (m *tunnelManager) snapshot() (host, target string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.host, m.target, m.client != nil
}

// dialContext 经活动隧道开一条 direct-tcpip 通道（每 HTTP 连接一条，随连接关闭）。
func (m *tunnelManager) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	m.mu.Lock()
	c := m.client
	target := m.target
	m.mu.Unlock()
	if c == nil {
		return nil, fmt.Errorf("SSH 隧道未建立")
	}
	return c.Dial(network, target)
}

func (m *tunnelManager) handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONErr(w, 405, "POST only")
		return
	}
	var b connectBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeJSONErr(w, 400, "invalid json: "+err.Error())
		return
	}
	host := b.Host
	if host == "" {
		writeJSONErr(w, 400, "host 不能为空（NMS 宿主机 ip 或 ip:port）")
		return
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(host, "22")
	}
	if b.User == "" || b.Password == "" {
		writeJSONErr(w, 400, "SSH 用户/密码不能为空")
		return
	}
	target := b.Target
	if target == "" {
		target = "127.0.0.1:8080"
	}
	cfg := &ssh.ClientConfig{
		User: b.User,
		Auth: []ssh.AuthMethod{
			ssh.Password(b.Password),
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				// 部分镜像只开 keyboard-interactive：同密码应答
				ans := make([]string, len(questions))
				for i := range questions {
					ans[i] = b.Password
				}
				return ans, nil
			}),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // 自用工具、已知宿主机；见 README 安全节
		Timeout:         8 * time.Second,
	}
	client, err := ssh.Dial("tcp", host, cfg)
	if err != nil {
		writeJSONErr(w, 502, "SSH 连接失败："+err.Error())
		return
	}
	// 打通性验证：开一条通道到 NMS API 立即关掉
	probe, err := client.Dial("tcp", target)
	if err != nil {
		client.Close()
		writeJSONErr(w, 502, fmt.Sprintf("隧道到 %s 不通：%v", target, err))
		return
	}
	probe.Close()

	m.mu.Lock()
	if m.client != nil {
		m.client.Close()
	}
	m.client, m.host, m.target = client, host, target
	m.mu.Unlock()

	writeJSONOK(w, map[string]any{"connected": true, "host": host, "target": target})
}

func (m *tunnelManager) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONErr(w, 405, "POST only")
		return
	}
	m.mu.Lock()
	if m.client != nil {
		m.client.Close()
		m.client = nil
	}
	m.mu.Unlock()
	writeJSONOK(w, map[string]any{"connected": false})
}

func (m *tunnelManager) handleStatus(w http.ResponseWriter, r *http.Request) {
	host, target, ok := m.snapshot()
	writeJSONOK(w, map[string]any{"connected": ok, "host": host, "target": target})
}

// tunnelTransport 隧道模式的 HTTP 传输：所有连接经 direct-tcpip 通道到 NMS。
func tunnelTransport(tm *tunnelManager) *http.Transport {
	return &http.Transport{DialContext: tm.dialContext}
}
