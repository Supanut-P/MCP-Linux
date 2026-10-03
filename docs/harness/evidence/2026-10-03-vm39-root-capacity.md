# Approved test VM root capacity expansion

The user explicitly approved using the existing approximately 18 GiB of
unallocated disk space on disposable Ubuntu VM 192.168.1.39. No additional
virtual disk was required. This is infrastructure evidence, separate from
v1.43 source/package acceptance.

Preflight confirmed `/dev/sda` was 53,687,091,200 bytes, `/dev/sda3` was
32,209,108,992 bytes, root was ext4 on `ubuntu-vg/ubuntu-lv`, and
`ubuntu-vg/lv-0` was the 16,106,127,360-byte home LV. `growpart -N` confirmed
the proposed end sector without a write. Root had 244,289,536 available bytes.

The bounded script is retained at
`dist/v1.43.0-local-20261003-r4/expand-vm39-root.sh`. It saves `sfdisk --dump`,
`vgcfgbackup`, layout and capacity before mutations under root-only
`/var/tmp/mcp-linux-disk-20261003/`. It then runs, sequentially:

```sh
growpart /dev/sda 3
pvresize /dev/sda3
lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
resize2fs /dev/ubuntu-vg/ubuntu-lv
```

SSH execution exited 0. Root filesystem now reports 34,755,887,104 bytes total
and 18,487,087,104 bytes available (45% used). Home LV size was asserted
unchanged before and after; its available space remains 594,927,616 bytes.
Both configured MCP and tunnel services remained active. No service restart
or home filesystem modification was performed.

Before-partition dump SHA256:
`e1ef6dfcbc8db17958e9919b24d32462631276bf46902bf6a419f8e6ac0afa1a`.
After-partition dump SHA256:
`1bb5e501cbceedc214f4e96965a43f06380a45ed51c113a7e5acc0966a5e614b`.
Before/after LVM metadata backups and all command logs remain on the VM.
Metadata backups support diagnosis; they are not a tested shrink/rollback
procedure. Root growth resolves capacity for subsequent test work; it does
not establish any later product milestone gate.
