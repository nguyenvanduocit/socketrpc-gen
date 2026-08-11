package socket

import (
	"errors"
	"reflect"
	"sync"
	"time"
)

type Ack = func([]any, error)
type EventListener func(...any)
type EventName string

type Emission struct {
	Event string
	Args  []any
}

type Socket struct {
	mu         sync.Mutex
	connected  bool
	listeners  map[string][]EventListener
	emissions  []Emission
	ackHandler func(string, []any) ([]any, error)
	timeout    time.Duration
}

func NewSocket() *Socket {
	return &Socket{connected: true, listeners: make(map[string][]EventListener)}
}

func (s *Socket) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

func (s *Socket) On(event string, listeners ...EventListener) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners[event] = append(s.listeners[event], listeners...)
	return nil
}

func (s *Socket) RemoveListener(event EventName, listener EventListener) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	target := reflect.ValueOf(listener).Pointer()
	listeners := s.listeners[string(event)]
	for index, candidate := range listeners {
		if reflect.ValueOf(candidate).Pointer() == target {
			s.listeners[string(event)] = append(listeners[:index], listeners[index+1:]...)
			return true
		}
	}
	return false
}

func (s *Socket) Emit(event string, args ...any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.connected {
		return errors.New("socket has been disconnected")
	}
	s.timeout = 0
	s.emissions = append(s.emissions, Emission{Event: event, Args: append([]any(nil), args...)})
	return nil
}

func (s *Socket) Timeout(timeout time.Duration) *Socket {
	s.mu.Lock()
	s.timeout = timeout
	s.mu.Unlock()
	return s
}

func (s *Socket) EmitWithAck(event string, args ...any) func(Ack) {
	return func(ack Ack) {
		s.mu.Lock()
		if !s.connected {
			s.mu.Unlock()
			go ack(nil, errors.New("socket has been disconnected"))
			return
		}
		handler := s.ackHandler
		timeout := s.timeout
		s.timeout = 0
		s.emissions = append(s.emissions, Emission{Event: event, Args: append([]any(nil), args...)})
		s.mu.Unlock()
		go func() {
			if handler == nil {
				time.Sleep(timeout)
				ack(nil, errors.New("operation has timed out"))
				return
			}
			values, err := handler(event, args)
			ack(values, err)
		}()
	}
}

func (s *Socket) SetAckHandler(handler func(string, []any) ([]any, error)) {
	s.mu.Lock()
	s.ackHandler = handler
	s.mu.Unlock()
}

func (s *Socket) Trigger(event string, args ...any) {
	s.mu.Lock()
	listeners := append([]EventListener(nil), s.listeners[event]...)
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(args...)
	}
}

func (s *Socket) Disconnect(reason string) {
	s.mu.Lock()
	s.connected = false
	s.mu.Unlock()
	s.Trigger("disconnect", reason)
}

func (s *Socket) Emissions() []Emission {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Emission, len(s.emissions))
	copy(result, s.emissions)
	return result
}
