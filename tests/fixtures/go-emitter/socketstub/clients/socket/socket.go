// Package socket is a hermetic stand-in for the Socket.IO client package the
// generated Go client is written against. It keeps the real package's
// signatures for every member the generated code touches, and adds Trigger*
// hooks a test drives the connection lifecycle through.
package socket

import (
	"errors"
	"reflect"
	"sync"
	"time"

	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// ---------------------------------------------------------------------------
// Options

type ManagerOptionsInterface interface {
	GetRawAutoConnect() *bool
	GetRawReconnection() *bool
}

type ManagerOptions struct {
	autoConnect  *bool
	reconnection *bool
	transports   *TransportSet
}

// TransportSet stands in for the real *types.Set[TransportCtor]: the stub only
// records which transports a Dial asked for.
type TransportSet struct{ Names []string }

func WebSocketOnly() *TransportSet { return &TransportSet{Names: []string{"websocket"}} }

func DefaultManagerOptions() *ManagerOptions { return &ManagerOptions{} }

func (o *ManagerOptions) Assign(data ManagerOptionsInterface) ManagerOptionsInterface {
	if data == nil {
		return o
	}
	if value := data.GetRawAutoConnect(); value != nil {
		o.SetAutoConnect(*value)
	}
	if value := data.GetRawReconnection(); value != nil {
		o.SetReconnection(*value)
	}
	return o
}

func (o *ManagerOptions) SetAutoConnect(value bool)         { o.autoConnect = &value }
func (o *ManagerOptions) GetRawAutoConnect() *bool          { return o.autoConnect }
func (o *ManagerOptions) SetReconnection(value bool)        { o.reconnection = &value }
func (o *ManagerOptions) GetRawReconnection() *bool         { return o.reconnection }
func (o *ManagerOptions) SetTransports(value *TransportSet) { o.transports = value }
func (o *ManagerOptions) Transports() *TransportSet         { return o.transports }

type SocketOptionsInterface interface {
	Auth() map[string]any
}

type SocketOptions struct{ auth map[string]any }

func DefaultSocketOptions() *SocketOptions           { return &SocketOptions{} }
func (o *SocketOptions) SetAuth(auth map[string]any) { o.auth = auth }
func (o *SocketOptions) Auth() map[string]any        { return o.auth }

// ---------------------------------------------------------------------------
// Event emitter

type emitter struct {
	mu        sync.Mutex
	listeners map[types.EventName][]types.EventListener
}

func (e *emitter) On(event types.EventName, listeners ...types.EventListener) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.listeners == nil {
		e.listeners = make(map[types.EventName][]types.EventListener)
	}
	e.listeners[event] = append(e.listeners[event], listeners...)
	return nil
}

func (e *emitter) RemoveListener(event types.EventName, listener types.EventListener) bool {
	if listener == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	target := reflect.ValueOf(listener).Pointer()
	listeners := e.listeners[event]
	for index, candidate := range listeners {
		if reflect.ValueOf(candidate).Pointer() == target {
			e.listeners[event] = append(listeners[:index], listeners[index+1:]...)
			return true
		}
	}
	return false
}

// ListenerCount reports how many listeners an event has, so a test can prove
// Dispose removed what Dial registered.
func (e *emitter) ListenerCount(event string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.listeners[types.EventName(event)])
}

func (e *emitter) emit(event string, args ...any) {
	e.mu.Lock()
	listeners := append([]types.EventListener(nil), e.listeners[types.EventName(event)]...)
	e.mu.Unlock()
	for _, listener := range listeners {
		listener(args...)
	}
}

// ---------------------------------------------------------------------------
// Manager

// Engine stands in for the engine socket interface; Manager.Engine returns nil
// until a test sets the limit a handshake would have advertised.
type Engine interface{}

type stubEngine struct{ maxPayload int64 }

func (e *stubEngine) MaxPayload() int64 { return e.maxPayload }

type Manager struct {
	emitter

	uri  string
	opts *ManagerOptions

	mu     sync.Mutex
	engine Engine
	socket *Socket
}

var (
	serveMu sync.Mutex
	servers = map[string]func(*Socket){}
)

// Serve decides what Connect does for sockets dialled at uri: onConnect runs
// synchronously inside Connect, so it may Trigger* the lifecycle at once or
// hand the socket to the test.
func Serve(uri string, onConnect func(*Socket)) {
	serveMu.Lock()
	defer serveMu.Unlock()
	servers[uri] = onConnect
}

func NewManager(uri string, opts ManagerOptionsInterface) *Manager {
	copied := DefaultManagerOptions()
	copied.Assign(opts)
	return &Manager{uri: uri, opts: copied}
}

func (m *Manager) Socket(nsp string, opts SocketOptionsInterface) *Socket {
	m.mu.Lock()
	defer m.mu.Unlock()
	socket := &Socket{io: m, nsp: nsp, active: true}
	if opts != nil {
		socket.auth = opts.Auth()
	}
	m.socket = socket
	return socket
}

func (m *Manager) Engine() Engine {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.engine
}

func (m *Manager) Reconnection() bool {
	if value := m.opts.GetRawReconnection(); value != nil {
		return *value
	}
	return true
}

// AutoConnect reports the option Dial must have turned off.
func (m *Manager) AutoConnect() bool {
	if value := m.opts.GetRawAutoConnect(); value != nil {
		return *value
	}
	return true
}

func (m *Manager) URI() string { return m.uri }

func (m *Manager) TriggerReconnectFailed() { m.emit("reconnect_failed") }

// ---------------------------------------------------------------------------
// Socket

type Emission struct {
	Event string
	Args  []any
}

// buffered is an emit made while disconnected, which the real socket keeps in
// its send buffer and sends on the next connection.
type buffered struct {
	emission Emission
	ack      server.Ack
	timeout  time.Duration
}

type Socket struct {
	emitter

	io   *Manager
	nsp  string
	auth map[string]any

	mu          sync.Mutex
	connected   bool
	active      bool
	session     int
	connects    int
	disconnects int
	emissions   []Emission
	sendBuffer  []buffered
	ackHandler  func(string, []any) ([]any, error)
	timeout     time.Duration
	noBuffer    bool
}

func (s *Socket) Io() *Manager { return s.io }

func (s *Socket) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

func (s *Socket) Active() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

func (s *Socket) Connect() *Socket {
	s.mu.Lock()
	s.connects++
	s.mu.Unlock()
	serveMu.Lock()
	onConnect := servers[s.io.uri]
	serveMu.Unlock()
	if onConnect != nil {
		onConnect(s)
	}
	return s
}

// Disconnect is the client-side close: the socket stops reconnecting, and
// reports the disconnect only if it was connected.
func (s *Socket) Disconnect() *Socket {
	s.mu.Lock()
	wasConnected := s.connected
	s.connected = false
	s.active = false
	s.disconnects++
	s.mu.Unlock()
	if wasConnected {
		s.emit("disconnect", "io client disconnect", nil)
	}
	return s
}

// Emit, like the real socket, buffers an emit made while disconnected and
// sends it on the next connection, unless NoBuffer was set for it: then the
// emit is dropped.
func (s *Socket) Emit(event string, args ...any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	noBuffer := s.noBuffer
	s.noBuffer = false
	s.timeout = 0
	emission := Emission{Event: event, Args: append([]any(nil), args...)}
	switch {
	case s.connected:
		s.emissions = append(s.emissions, emission)
	case !noBuffer:
		s.sendBuffer = append(s.sendBuffer, buffered{emission: emission})
	}
	return nil
}

func (s *Socket) Timeout(timeout time.Duration) *Socket {
	s.mu.Lock()
	s.timeout = timeout
	s.mu.Unlock()
	return s
}

// NoBuffer sets the flag the next Emit or EmitWithAck consumes: an emit made
// while disconnected is not buffered, and its acknowledgement is settled at
// once with the socket's disconnected error.
func (s *Socket) NoBuffer() *Socket {
	s.mu.Lock()
	s.noBuffer = true
	s.mu.Unlock()
	return s
}

func (s *Socket) EmitWithAck(event string, args ...any) func(server.Ack) {
	return func(ack server.Ack) {
		s.mu.Lock()
		noBuffer := s.noBuffer
		timeout := s.timeout
		s.noBuffer = false
		s.timeout = 0
		emission := Emission{Event: event, Args: append([]any(nil), args...)}
		if !s.connected {
			if !noBuffer {
				s.sendBuffer = append(s.sendBuffer, buffered{emission: emission, ack: ack, timeout: timeout})
			}
			s.mu.Unlock()
			if noBuffer {
				ack(nil, errors.New("socket has been disconnected"))
			}
			return
		}
		s.send(emission, ack, timeout)
		s.mu.Unlock()
	}
}

// send records one emission and answers its acknowledgement through the ack
// handler, as the server would. The caller holds mu.
func (s *Socket) send(emission Emission, ack server.Ack, timeout time.Duration) {
	s.emissions = append(s.emissions, emission)
	if ack == nil {
		return
	}
	handler := s.ackHandler
	go func() {
		if handler == nil {
			time.Sleep(timeout)
			ack(nil, errors.New("operation has timed out"))
			return
		}
		values, err := handler(emission.Event, emission.Args)
		ack(values, err)
	}()
}

// ---------------------------------------------------------------------------
// Test hooks

func (s *Socket) Namespace() string    { return s.nsp }
func (s *Socket) Auth() map[string]any { return s.auth }

func (s *Socket) SetAckHandler(handler func(string, []any) ([]any, error)) {
	s.mu.Lock()
	s.ackHandler = handler
	s.mu.Unlock()
}

func (s *Socket) SetEngineMaxPayload(limit int64) {
	s.io.mu.Lock()
	s.io.engine = &stubEngine{maxPayload: limit}
	s.io.mu.Unlock()
}

func (s *Socket) Emissions() []Emission {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Emission(nil), s.emissions...)
}

// Counts reports how often Connect and Disconnect were called.
func (s *Socket) Counts() (connects, disconnects int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connects, s.disconnects
}

// TriggerConnect opens a new connection: a new engine session, on which the
// send buffer is flushed before the connect event, as the real socket does.
func (s *Socket) TriggerConnect() {
	s.mu.Lock()
	s.connected = true
	s.active = true
	s.session++
	for _, pending := range s.sendBuffer {
		s.send(pending.emission, pending.ack, pending.timeout)
	}
	s.sendBuffer = nil
	s.mu.Unlock()
	s.emit("connect")
}

// TriggerDisconnect reports a loss. active says whether the socket will try
// again, as the real one does after a transport close but not after the server
// disconnected it.
func (s *Socket) TriggerDisconnect(reason string, active bool) {
	s.BeginDisconnect(active)(reason)
}

// BeginDisconnect is the first half of a loss: the socket stops being
// connected, as the real one does before it reports the loss. The returned
// function reports it, so a test can act in between.
func (s *Socket) BeginDisconnect(active bool) func(reason string) {
	s.mu.Lock()
	s.connected = false
	s.active = active
	s.mu.Unlock()
	return func(reason string) { s.emit("disconnect", reason, nil) }
}

// TriggerConnectError reports a failed attempt. A refused handshake leaves the
// socket inactive; a transport error leaves it retrying.
func (s *Socket) TriggerConnectError(message string, active bool) {
	s.mu.Lock()
	s.active = active
	s.mu.Unlock()
	s.emit("connect_error", errors.New(message))
}

// Trigger delivers an event from the server, synchronously, as the real
// socket does on its read goroutine.
func (s *Socket) Trigger(event string, args ...any) { s.emit(event, args...) }

// TriggerWithAck delivers an acknowledged event from the server and returns
// the channel the acknowledgement reaches the server on. As in the real
// socket, the acknowledgement is bound to the engine session the event arrived
// on: written after a reconnect, or while disconnected, it never arrives.
func (s *Socket) TriggerWithAck(event string, args ...any) <-chan []any {
	s.mu.Lock()
	session := s.session
	s.mu.Unlock()
	answers := make(chan []any, 1)
	var once sync.Once
	ack := func(values []any, _ error) {
		once.Do(func() {
			s.mu.Lock()
			current := s.connected && s.session == session
			s.mu.Unlock()
			if current {
				answers <- values
			}
		})
	}
	s.emit(event, append(append([]any(nil), args...), server.Ack(ack))...)
	return answers
}
