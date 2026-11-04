// Package types mirrors the two event-emitter types the generated client
// passes to the real clients/socket package, so a stub that compiles against
// them catches the same conversions the real package needs.
package types

type EventName string
type EventListener func(...any)
