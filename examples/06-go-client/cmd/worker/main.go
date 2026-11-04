// Command worker dials the coordinator, registers itself on every connection,
// and runs the tasks the coordinator sends it until interrupted.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"example.com/coordinator/wire"
	"example.com/coordinator/wireclient"
)

// worker implements the generated wireclient.ClientHandler. One value serves
// the connection for its whole life, reconnects included.
type worker struct {
	conn atomic.Pointer[wireclient.Conn]
}

func (w *worker) HandleRunTask(ctx context.Context, task wire.Task) (wire.TaskResult, error) {
	for _, percent := range []float64{25, 50, 75} {
		if conn := w.conn.Load(); conn != nil {
			// Fire-and-forget; a progress line lost to a reconnect is not worth failing the task.
			_ = conn.CallProgress(ctx, task.ID, percent)
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-ctx.Done():
			return wire.TaskResult{}, ctx.Err()
		}
	}
	return wire.TaskResult{TaskID: task.ID, Output: fmt.Sprintf("handled %q", task.Prompt)}, nil
}

func (w *worker) HandleCancelTask(_ context.Context, taskID string) error {
	log.Printf("coordinator cancelled %s", taskID)
	return nil
}

func main() {
	address := flag.String("url", "http://127.0.0.1:3000", "coordinator address; the namespace is set in DialOptions")
	token := flag.String("token", "worker-secret", "token sent in the auth payload")
	name := flag.String("name", "worker-1", "name this worker registers under")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	handler := &worker{}
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	conn, err := wireclient.Dial(dialCtx, *address, handler, &wireclient.DialOptions{
		Namespace: "/worker",
		Auth:      map[string]any{"token": *token},
		Timeout:   10 * time.Second,
	})
	cancel()
	if err != nil {
		var failure *wire.RpcError
		if errors.As(err, &failure) {
			log.Fatalf("dial: %s: %s", failure.Code, failure.Message)
		}
		log.Fatalf("dial: %v", err)
	}
	defer conn.Dispose()
	handler.conn.Store(conn)

	register := func() {
		callCtx, cancel := context.WithTimeout(conn.Context(), 5*time.Second)
		defer cancel()
		registration, err := conn.CallRegister(callCtx, wire.Worker{Name: *name, Capacity: 4})
		if err != nil {
			log.Printf("register: %v", err)
			return
		}
		log.Printf("registered as %s with %v pending", registration.WorkerID, registration.Pending)
	}
	// Subscribe first, then announce: the registration is never missed, and at
	// worst sent twice.
	conn.OnConnect(register)
	conn.OnDisconnect(func(reason string) { log.Printf("disconnected (%s); reconnecting", reason) })
	register()

	select {
	case <-ctx.Done():
	case <-conn.Done():
		log.Printf("connection ended: %v", conn.Err())
	}
}
