#version=F34
# MOS Desktop 12 test bench, UEFI/GPT, one dedicated 64 GiB virtual disk.
# prepare.cjs replaces the password placeholder in the ignored runtime copy.
text --non-interactive
eula --agreed
firstboot --disable
lang ru_RU.UTF-8
keyboard --vckeymap=us --xlayouts=us,ru --switch=grp:alt_shift_toggle
timezone Europe/Moscow --utc
network --bootproto=dhcp --device=link --activate --hostname=mos-exam-testbed
selinux --disabled
rootpw --lock
user --name=mosqa --groups=wheel --password=__MOS_QA_PASSWORD_HASH__ --iscrypted --gecos="MOS test bench"
xconfig --startxonboot
services --enabled=NetworkManager,qemu-guest-agent,sshd,sddm

# Install the pristine base filesystem mapped by Dracut from the official ISO.
# The --liveinst mode intentionally ignores kickstart; use inst.ks at boot.
liveimg --url=file:///dev/mapper/live-base

ignoredisk --only-use=vda
zerombr
clearpart --all --drives=vda --initlabel --disklabel=gpt
part /boot/efi --fstype=efi --size=600 --ondisk=vda --fsoptions="umask=0077,shortname=winnt"
part /boot --fstype=ext4 --size=1024 --ondisk=vda
part swap --fstype=swap --size=4096 --ondisk=vda
part / --fstype=ext4 --size=20480 --grow --ondisk=vda
bootloader --boot-drive=vda --location=mbr --append="console=tty0 console=ttyS0,115200n8"

%post --interpreter=/bin/bash --erroronfail --log=/var/log/anaconda/mos-testbed-post.log
set -eu
systemctl enable NetworkManager.service qemu-guest-agent.service sshd.service sddm.service
systemctl set-default graphical.target
mkdir -p /etc/sddm.conf.d
cat > /etc/sddm.conf.d/90-mos-testbed.conf <<'EOF'
[Autologin]
User=mosqa
Session=01plasma.desktop
Relogin=true
EOF
chmod 0644 /etc/sddm.conf.d/90-mos-testbed.conf
printf '%s\n' 'MOS Desktop 12 / MOS-V release 260926 / exam simulator test bench' > /etc/mos-testbed
%end

# Stop at completion so the host can restart the installed disk without the ISO.
shutdown
