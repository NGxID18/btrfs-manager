# BTRFS Manager for Cockpit

## Project Details
BTRFS Manager is a lightweight, native web interface extension for the Cockpit Project. It is designed to provide comprehensive management of BTRFS filesystems directly from your web browser. 

Built entirely with Vanilla JavaScript, HTML, and custom CSS, this extension closely mimics the native PatternFly design system utilized by Cockpit—including automatic Dark Mode support—without requiring complex build tools, Node.js, or NPM. 

By leveraging Cockpit's native `spawn` API, the extension communicates directly with the system's command-line utilities. This ensures maximum portability, zero backend daemon requirements, and immediate execution of advanced filesystem commands.

### Core Features
* Master-Detail Dashboard: A responsive grid layout that provides a high-level overview of all BTRFS volumes, with dedicated detail pages for advanced management.
* Volume & RAID Creation: Format empty block devices into new BTRFS volumes with support for Single, RAID 0, RAID 1, and RAID 10 profiles. The system includes strict safety checks to only display unallocated disks.
* Physical Device Management: View physical device topology, add new blank disks to expand capacity online, and safely remove (evacuate) disks from an active volume.
* Subvolumes & Snapshots: Create and delete subvolumes for logical data isolation. Take instant root or subvolume snapshots, and restore/clone them with a single click.
* Maintenance & Health: Run background scrubs to detect bit-rot, perform data balancing (with 50% usage filters), and trigger live filesystem defragmentation.

## Dependencies
To use this extension, ensure your Linux server has the following standard packages installed and running:

* `cockpit`: The core Cockpit web console environment.
* `btrfs-progs`: The standard userspace utilities for BTRFS filesystem management.
* `util-linux`: Required for the `lsblk` and `findmnt` commands, which the extension uses to safely scan block devices and map active mount points.

## Installation
Because this is a vanilla frontend extension, no build process is required. You can install it simply by cloning the repository into your Cockpit extensions directory.

1. Open a terminal on your Linux server.
2. Clone this repository into the user-specific Cockpit extensions folder:
   ```bash
   git clone [https://github.com/NGxID18/btrfs-manager] ~/.local/share/cockpit/btrfs-manager
   ```
   (Note: For a system-wide installation available to all users, clone it to /usr/share/cockpit/btrfs-manager instead. This requires root privileges).
   ```bash
   sudo git clone [https://github.com/NGxID18/btrfs-manager] /usr/share/cockpit/btrfs-manager
   ```

3. Ensure the directory has the correct permissions (optional but recommended):
    ```bash
    chmod -R 644 ~/.local/share/cockpit/btrfs-manager/*
    chmod 755 ~/.local/share/cockpit/btrfs-manager
    ```
    
4. Open your web browser, log in to your Cockpit interface, and refresh the page. The "BTRFS" menu will appear in the left navigation sidebar.


Usage
Master View: Upon navigating to the BTRFS menu, you will see a grid of all detected BTRFS volumes on your system.

Detail View: Click "Manage Volume" on any card to access its specific device topology, subvolume tree, and maintenance console.

Adding Devices: When clicking "Add Disk to Volume", the extension will automatically scan and present only completely unallocated and safe block devices to prevent accidental data loss.

Restoring Snapshots: To restore a snapshot, click "Restore / Clone" next to the target snapshot. The system will prompt you for a new subvolume name to safely clone the snapshot without overwriting active data directories.