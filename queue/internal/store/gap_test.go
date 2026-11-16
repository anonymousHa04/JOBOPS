package store

import (
	"encoding/json"
	"testing"
)

// The mac group must lease no more tasks at once than general14 has slots (llm.sh, default 3),
// or the extra requests wait inside llama-server while their timeout runs (the Gaps tab's
// "Explain all" timed out this way). Gap help goes through the queue too.

func queueTailor(t *testing.T, s *Store, jobs ...string) {
	t.Helper()
	for _, j := range jobs {
		if _, err := s.db.Exec(`INSERT INTO queue_tasks (batch_id, job_id, stage, prompt_version, state, created_at, updated_at)
			VALUES (1, ?, 'tailor', 'v', 'queued', 'now', 'now')`, j); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMacSlots(t *testing.T) {
	t.Run("three mac tasks at a time by default, never a fourth", func(t *testing.T) {
		t.Setenv("JOBOPS_MAC_SLOTS", "")
		s, _ := newStore(t)
		addJobs(t, s, 4)
		queueTailor(t, s, "job-01", "job-02", "job-03", "job-04")
		for i := 0; i < 3; i++ {
			if must(s.Lease([]string{"tailor"}, "w")) == nil {
				t.Fatalf("lease %d refused", i+1)
			}
		}
		if got := must(s.Lease([]string{"tailor"}, "w")); got != nil {
			t.Fatalf("a fourth mac task was leased with 3 slots: %+v", got)
		}
	})
	t.Run("JOBOPS_MAC_SLOTS changes it", func(t *testing.T) {
		t.Setenv("JOBOPS_MAC_SLOTS", "2")
		s, _ := newStore(t)
		addJobs(t, s, 3)
		queueTailor(t, s, "job-01", "job-02", "job-03")
		for i := 0; i < 2; i++ {
			if must(s.Lease([]string{"tailor"}, "w")) == nil {
				t.Fatalf("lease %d refused with 2 slots", i+1)
			}
		}
		if must(s.Lease([]string{"tailor"}, "w")) != nil {
			t.Fatal("a third task was leased with 2 slots")
		}
	})
}

func TestGapHelp(t *testing.T) {
	t.Run("one task per gap, under one batch; an open one is not queued twice", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 1)
		id, n := must2(s.GapHelp("job-01", []string{"aaa", "bbb"}))
		if id == 0 || n != 2 {
			t.Fatalf("batch %d, queued %d; want a batch and 2", id, n)
		}
		_, n = must2(s.GapHelp("job-01", []string{"aaa", "ccc"}))
		if n != 1 {
			t.Fatalf("queued %d; want 1 (aaa is already open)", n)
		}
		if got := tasks(t, s, "stage = 'gap_help'"); len(got) != 3 {
			t.Fatalf("%d gap_help tasks; want 3", len(got))
		}
	})
	t.Run("leased before tailor, final when done, nothing queued after it", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 2)
		queueTailor(t, s, "job-02")
		must2(s.GapHelp("job-01", []string{"aaa"}))
		task := must(s.Lease([]string{"gap_help", "tailor"}, "mac"))
		if task == nil || task.Stage != "gap_help" {
			t.Fatalf("leased %+v; want the gap_help task first", task)
		}
		if err := s.Done(task.ID, json.RawMessage(`{"related":3}`)); err != nil {
			t.Fatal(err)
		}
		got := tasks(t, s, "job_id = 'job-01'")
		if len(got) != 1 || got[0].State != "done" || got[0].Final != 1 {
			t.Fatalf("job-01 tasks %+v; want one final done gap_help task", got)
		}
	})
	t.Run("a gap that is done can be asked again", func(t *testing.T) {
		s, _ := newStore(t)
		addJobs(t, s, 1)
		must2(s.GapHelp("job-01", []string{"aaa"}))
		task := must(s.Lease([]string{"gap_help"}, "mac"))
		if err := s.Done(task.ID, nil); err != nil {
			t.Fatal(err)
		}
		if _, n := must2(s.GapHelp("job-01", []string{"aaa"})); n != 1 {
			t.Fatalf("queued %d; want 1 (Refresh)", n)
		}
	})
}

func must2[A, B any](a A, b B, err error) (A, B) {
	if err != nil {
		panic(err)
	}
	return a, b
}
