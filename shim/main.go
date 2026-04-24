package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

type config struct {
	RealCodexPath      string `json:"realCodexPath"`
	LogPath            string `json:"logPath"`
	CodexHome          string `json:"codexHome,omitempty"`
	RuntimeMappingPath string `json:"runtimeMappingPath,omitempty"`
}

type runtimeMappingFile struct {
	Version int                             `json:"version"`
	Windows map[string]runtimeWindowMapping `json:"windows"`
}

type runtimeWindowMapping struct {
	VSCodePid      string `json:"vscodePid"`
	WorkspaceKey   string `json:"workspaceKey,omitempty"`
	WorkspaceLabel string `json:"workspaceLabel,omitempty"`
	ProfileID      string `json:"profileId,omitempty"`
	ProfileName    string `json:"profileName,omitempty"`
	CodexHome      string `json:"codexHome,omitempty"`
	UpdatedAt      string `json:"updatedAt,omitempty"`
}

type invocationLog struct {
	Time          string            `json:"time"`
	ShimPath      string            `json:"shimPath"`
	RealCodexPath string            `json:"realCodexPath"`
	Cwd           string            `json:"cwd"`
	Args          []string          `json:"args"`
	Pid           int               `json:"pid"`
	ParentPid     int               `json:"parentPid"`
	Goos          string            `json:"goos"`
	Goarch        string            `json:"goarch"`
	Env           map[string]string `json:"env"`
	CodexHome     string            `json:"codexHome,omitempty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "codex-switcher-shim: %v\n", err)
		os.Exit(127)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if cfg.RealCodexPath == "" {
		return errors.New("realCodexPath is missing from shim config")
	}

	resolvedCodexHome := resolveCodexHome(cfg)

	if err := appendInvocationLog(cfg, resolvedCodexHome); err != nil {
		fmt.Fprintf(os.Stderr, "codex-switcher-shim: failed to write invocation log: %v\n", err)
	}

	cmd := exec.Command(cfg.RealCodexPath, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if resolvedCodexHome != "" {
		cmd.Env = appendWithoutEnvKey(cmd.Env, "CODEX_HOME")
		cmd.Env = append(cmd.Env, "CODEX_HOME="+resolvedCodexHome)
	}

	err = cmd.Run()
	if err == nil {
		return nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		os.Exit(exitCode(exitErr))
	}
	return err
}

func resolveCodexHome(cfg config) string {
	if cfg.RuntimeMappingPath != "" {
		if mapping, err := readRuntimeMapping(cfg.RuntimeMappingPath); err == nil {
			for _, key := range runtimeRouteKeys() {
				if window, ok := mapping.Windows[key]; ok && window.CodexHome != "" {
					return window.CodexHome
				}
			}
		}
	}
	return cfg.CodexHome
}

func runtimeRouteKeys() []string {
	keys := []string{fmt.Sprintf("%d", os.Getppid())}
	if vscodePid := os.Getenv("VSCODE_PID"); vscodePid != "" {
		keys = append(keys, vscodePid)
	}
	return keys
}

func readRuntimeMapping(filePath string) (runtimeMappingFile, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return runtimeMappingFile{}, err
	}
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})

	var mapping runtimeMappingFile
	if err := json.Unmarshal(raw, &mapping); err != nil {
		return runtimeMappingFile{}, err
	}
	if mapping.Windows == nil {
		mapping.Windows = map[string]runtimeWindowMapping{}
	}
	return mapping, nil
}

func loadConfig() (config, error) {
	exePath, err := os.Executable()
	if err != nil {
		return config{}, err
	}

	configPath := filepath.Join(filepath.Dir(exePath), "codex-switcher-shim.json")
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return config{}, fmt.Errorf("read %s: %w", configPath, err)
	}
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})

	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return config{}, fmt.Errorf("parse %s: %w", configPath, err)
	}
	return cfg, nil
}

func appendInvocationLog(cfg config, resolvedCodexHome string) error {
	if cfg.LogPath == "" {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(cfg.LogPath), 0o700); err != nil {
		return err
	}

	exePath, _ := os.Executable()
	cwd, _ := os.Getwd()
	entry := invocationLog{
		Time:          time.Now().UTC().Format(time.RFC3339Nano),
		ShimPath:      exePath,
		RealCodexPath: cfg.RealCodexPath,
		Cwd:           cwd,
		Args:          os.Args[1:],
		Pid:           os.Getpid(),
		ParentPid:     os.Getppid(),
		Goos:          runtime.GOOS,
		Goarch:        runtime.GOARCH,
		Env: map[string]string{
			"CODEX_HOME":           os.Getenv("CODEX_HOME"),
			"HOME":                 os.Getenv("HOME"),
			"USERPROFILE":          os.Getenv("USERPROFILE"),
			"VSCODE_PID":           os.Getenv("VSCODE_PID"),
			"VSCODE_CWD":           os.Getenv("VSCODE_CWD"),
			"VSCODE_IPC_HOOK":      os.Getenv("VSCODE_IPC_HOOK"),
			"TERM_PROGRAM":         os.Getenv("TERM_PROGRAM"),
			"ELECTRON_RUN_AS_NODE": os.Getenv("ELECTRON_RUN_AS_NODE"),
		},
		CodexHome: resolvedCodexHome,
	}

	f, err := os.OpenFile(cfg.LogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	encoder := json.NewEncoder(f)
	return encoder.Encode(entry)
}

func appendWithoutEnvKey(env []string, key string) []string {
	prefix := key + "="
	out := env[:0]
	for _, item := range env {
		if len(item) >= len(prefix) && item[:len(prefix)] == prefix {
			continue
		}
		out = append(out, item)
	}
	return out
}

func exitCode(exitErr *exec.ExitError) int {
	if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
		return status.ExitStatus()
	}
	if exitErr.ProcessState != nil {
		return exitErr.ProcessState.ExitCode()
	}
	_, _ = io.WriteString(os.Stderr, exitErr.Error())
	return 1
}
