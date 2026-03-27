#!/bin/bash
file=$1
sed -i '/<<<<<<< HEAD/,/=======/d' "$file"
sed -i '/>>>>>>> origin\/main/d' "$file"
