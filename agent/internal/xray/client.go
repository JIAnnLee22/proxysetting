// Package xray uses the official v26.3.27 Xray protobufs (not local imitations).
package xray

import (
	"context"
	"errors"
	"strings"

	handler "github.com/xtls/xray-core/app/proxyman/command"
	stats "github.com/xtls/xray-core/app/stats/command"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/proxy/vless"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"proxysetting/agent/internal/model"
)

var ErrAPI = errors.New("local Xray API operation failed")

type Counter struct {
	Up   uint64
	Down uint64
}
type API interface {
	Stats(context.Context) (map[string]Counter, error)
	Users(context.Context) ([]string, error)
	Add(context.Context, model.User) error
	Remove(context.Context, string) error
	Health(context.Context) (uint32, error)
}
type Client struct {
	conn    *grpc.ClientConn
	handler handler.HandlerServiceClient
	stats   stats.StatsServiceClient
}

func New() (*Client, error) {
	conn, e := grpc.NewClient(model.APIAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if e != nil {
		return nil, ErrAPI
	}
	return &Client{conn: conn, handler: handler.NewHandlerServiceClient(conn), stats: stats.NewStatsServiceClient(conn)}, nil
}
func (c *Client) Close() error { return c.conn.Close() }
func (c *Client) Stats(ctx context.Context) (map[string]Counter, error) {
	r, e := c.stats.QueryStats(ctx, &stats.QueryStatsRequest{Pattern: "user>>>", Reset_: false})
	if e != nil {
		return nil, ErrAPI
	}
	out := map[string]Counter{}
	seen := map[string]bool{}
	for _, s := range r.Stat {
		if s == nil || s.Value < 0 || uint64(s.Value) > model.MaxSafe || seen[s.Name] {
			return nil, ErrAPI
		}
		seen[s.Name] = true
		p := strings.Split(s.Name, ">>>")
		if len(p) != 4 || p[0] != "user" || p[2] != "traffic" {
			continue
		}
		v := out[p[1]]
		switch p[3] {
		case "uplink":
			v.Up = uint64(s.Value)
		case "downlink":
			v.Down = uint64(s.Value)
		default:
			continue
		}
		out[p[1]] = v
	}
	return out, nil
}
func (c *Client) Users(ctx context.Context) ([]string, error) {
	r, e := c.handler.GetInboundUsers(ctx, &handler.GetInboundUserRequest{Tag: model.InboundTag})
	if e != nil {
		return nil, ErrAPI
	}
	out := make([]string, 0, len(r.Users))
	for _, u := range r.Users {
		if u == nil || u.Email == "" {
			return nil, ErrAPI
		}
		out = append(out, u.Email)
	}
	return out, nil
}
func (c *Client) Add(ctx context.Context, u model.User) error {
	_, e := c.handler.AlterInbound(ctx, &handler.AlterInboundRequest{Tag: model.InboundTag, Operation: serial.ToTypedMessage(&handler.AddUserOperation{User: &protocol.User{Level: 0, Email: u.Email, Account: serial.ToTypedMessage(&vless.Account{Id: u.UUID, Flow: "xtls-rprx-vision", Encryption: "none"})}})})
	if e != nil {
		return ErrAPI
	}
	return nil
}
func (c *Client) Remove(ctx context.Context, email string) error {
	_, e := c.handler.AlterInbound(ctx, &handler.AlterInboundRequest{Tag: model.InboundTag, Operation: serial.ToTypedMessage(&handler.RemoveUserOperation{Email: email})})
	if e != nil {
		return ErrAPI
	}
	return nil
}
func (c *Client) Health(ctx context.Context) (uint32, error) {
	r, e := c.stats.GetSysStats(ctx, &stats.SysStatsRequest{})
	if e != nil {
		return 0, ErrAPI
	}
	return r.Uptime, nil
}
