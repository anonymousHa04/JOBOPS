// Package events: the queue's change feed. Every store change that moves a job or a batch
// (a task queued, leased, done or failed, a batch started, a job forgotten) is published here,
// and GET /events streams it as Server-Sent Events. The API relays it to the UI, and workers
// wait on it instead of asking for work every few seconds.
//
// An event says what changed, not the new data: a listener reads the state it needs again.
// A listener that falls behind is dropped (its stream ends); on reconnect it reloads.
package events

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Event: Kind is "task" (a task changed state), "batch" (batch started or retried), "job" (a job
// forgotten) or "filter" (the preference check changed which jobs are skipped).
type Event struct {
	Seq     int64  `json:"seq"`
	Kind    string `json:"kind"`
	JobID   string `json:"job_id,omitempty"`
	BatchID int64  `json:"batch_id,omitempty"`
	Stage   string `json:"stage,omitempty"`
	State   string `json:"state,omitempty"` // queued, leased, done, failed
}

type Hub struct {
	mu   sync.Mutex
	seq  int64
	subs map[chan Event]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan Event]struct{}{}} }

// Publish never blocks: a subscriber whose buffer is full is dropped.
func (h *Hub) Publish(e Event) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	e.Seq = h.seq
	for ch := range h.subs {
		select {
		case ch <- e:
		default:
			delete(h.subs, ch)
			close(ch)
		}
	}
}

// Subscribe returns a channel of events and a cancel function. The channel is closed when the
// subscriber is dropped or cancelled.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
	}
}

// Keepalive: a comment line this often, so proxies and port-forwards keep an idle stream open
// (and Node's fetch, which gives up on a body silent for 5 minutes).
const Keepalive = 20 * time.Second

// ServeSSE streams events until the client goes away or it is dropped.
func (h *Hub) ServeSSE(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("x-accel-buffering", "no")
	w.WriteHeader(http.StatusOK)
	ch, cancel := h.Subscribe()
	defer cancel()
	// retry: how long EventSource waits before reconnecting; "ready" tells the client the stream
	// is open, so it reloads once (events from before were missed).
	fmt.Fprint(w, "retry: 3000\nevent: ready\ndata: {}\n\n")
	if err := rc.Flush(); err != nil {
		return
	}
	tick := time.NewTicker(Keepalive)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			fmt.Fprint(w, ": keepalive\n\n")
		case e, ok := <-ch:
			if !ok {
				return // dropped: the client reconnects and reloads
			}
			b, _ := json.Marshal(e)
			fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.Seq, e.Kind, b)
		}
		if err := rc.Flush(); err != nil {
			return
		}
	}
}
